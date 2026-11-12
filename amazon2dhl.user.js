// ==UserScript==
// @name         Amazon2DHL - Lieferschein AutoFill
// @namespace    https://github.com/selimcifci/Amazon2DHL
// @version      1.7.1
// @description  Liest Amazon Lieferschein-PDFs (Seller Central) aus und uebertraegt Empfaenger, Adresse und Bestellnummer automatisch in das DHL Geschaeftskundenportal (ShipmentDetails).
// @author       Selim Cifci
// @match        https://geschaeftskunden.dhl.de/*
// @match        https://sellercentral.amazon.de/orders/packing-slip*
// @match        https://sellercentral-europe.amazon.com/orders/packing-slip*
// @match        https://sellercentral.amazon.com/orders/packing-slip*
// @match        https://sellercentral.amazon.co.uk/orders/packing-slip*
// @match        https://sellercentral.amazon.fr/orders/packing-slip*
// @match        https://sellercentral.amazon.it/orders/packing-slip*
// @match        https://sellercentral.amazon.es/orders/packing-slip*
// @match        https://sellercentral.amazon.nl/orders/packing-slip*
// @match        https://sellercentral.amazon.pl/orders/packing-slip*
// @match        https://*.sellercentral.amazon.tld/orders/packing-slip*
// @include      /^https:\/\/[^\/]*?\.sellercentral\.amazon\.[^\/]*?\/orders\/packing-slip.*?$/
// @noframes
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @resource     pdfWorker https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// @grant        GM_getResourceURL
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  // Sicherheitspruefung: Nur im jeweiligen Hauptfenster ausfuehren
  if (window.self !== window.top) {
    return;
  }

  const host = window.location.hostname;

  // =========================================================================
  // A. AMAZON SELLER CENTRAL MODUL (LIEFERSCHEIN-TAB)
  // =========================================================================
  if (host.includes('sellercentral') || host.includes('amazon')) {
    function syncAmazonOrder() {
      const bodyText = document.body ? document.body.innerText : '';
      if (!bodyText) return;

      if (bodyText.includes('Liefern an') || bodyText.includes('Bestellnummer') || bodyText.includes('Lieferanschrift')) {
        let orderId = '';
        const orderIdMatch = bodyText.match(/Bestellnummer:\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/i) ||
                             window.location.search.match(/orderId=([0-9]{3}-[0-9]{7}-[0-9]{7})/);
        if (orderIdMatch) orderId = orderIdMatch[1];

        const payload = {
          orderId,
          text: bodyText,
          url: window.location.href,
          timestamp: Date.now()
        };

        if (typeof GM_setValue === 'function') {
          GM_setValue('latest_amazon_order', payload);
          console.log('[Amazon2DHL] Amazon Lieferschein synchronisiert:', orderId);
        }
      }
    }

    syncAmazonOrder();
    window.addEventListener('focus', syncAmazonOrder);

    // Auf Aenderungen und Pings von DHL reagieren
    const observer = new MutationObserver(() => syncAmazonOrder());
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener('amazon2dhl_ping', () => {
        syncAmazonOrder();
      });
    }

    return;
  }

  // =========================================================================
  // B. DHL GESCHAEFTSKUNDENPORTAL MODUL
  // =========================================================================
  if (!host.includes('geschaeftskunden.dhl.de')) {
    return;
  }

  // 1. PDF.js WORKER SETUP
  function initPdfWorker() {
    if (typeof pdfjsLib === 'undefined') {
      console.error('[Amazon2DHL] pdfjsLib ist nicht geladen.');
      return;
    }
    try {
      if (typeof GM_getResourceURL === 'function') {
        const workerUrl = GM_getResourceURL('pdfWorker');
        if (workerUrl) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
          return;
        }
      }
    } catch (e) {
      console.warn('[Amazon2DHL] GM_getResourceURL fallback:', e);
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // 2. PARSER-LOGIK FUER AMAZON LIEFERSCHEIN
  async function extractTextFromPdf(data) {
    initPdfWorker();
    const arrayBuffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
    const pdf = await loadingTask.promise;

    let fullText = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      const items = textContent.items
        .map(it => ({
          str: it.str || '',
          x: it.transform ? it.transform[4] : 0,
          y: it.transform ? it.transform[5] : 0
        }))
        .filter(it => it.str.trim().length > 0);

      items.sort((a, b) => b.y - a.y || a.x - b.x);

      const lines = [];
      let currentLine = [];
      let currentY = -999999;

      for (const item of items) {
        if (Math.abs(item.y - currentY) > 4) {
          if (currentLine.length > 0) {
            currentLine.sort((a, b) => a.x - b.x);
            lines.push(currentLine.map(i => i.str).join(' '));
          }
          currentLine = [item];
          currentY = item.y;
        } else {
          currentLine.push(item);
        }
      }
      if (currentLine.length > 0) {
        currentLine.sort((a, b) => a.x - b.x);
        lines.push(currentLine.map(i => i.str).join(' '));
      }

      fullText += lines.join('\n') + '\n\n';
    }

    return fullText;
  }

  function parseAmazonText(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let orderId = '';
    const orderIdMatch = text.match(/Bestellnummer:\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/i);
    if (orderIdMatch) {
      orderId = orderIdMatch[1].trim();
    } else {
      const fallbackOrderId = text.match(/\b([0-9]{3}-[0-9]{7}-[0-9]{7})\b/);
      if (fallbackOrderId) orderId = fallbackOrderId[1].trim();
    }

    let buyerOrderId = '';
    const buyerMatch = text.match(/Bestellnummer des Käufers:\s*(.*?)(?=\n\s*(?:Bestellnummer:|Vielen Dank|Lieferanschrift|$))/is);
    if (buyerMatch) {
      buyerOrderId = buyerMatch[1].replace(/\s+/g, ' ').trim();
    }

    let erfasstName = '';
    const erfasstMatch = text.match(/Erfasst fuer DHL:\s*([^\n\r]+)/i);
    if (erfasstMatch) {
      erfasstName = erfasstMatch[1].trim();
    }

    let addrBlock = '';
    const blockMatch = text.match(/Liefern an:\s*(.*?)(?=\n\s*(?:Bestellnummer des Käufers:|Bestellnummer:))/is);
    if (blockMatch) {
      addrBlock = blockMatch[1].trim();
    } else {
      const altMatch = text.match(/Lieferanschrift:\s*(.*?)(?=\n\s*(?:Bestellt am:|Menge|Vielen Dank|$))/is);
      if (altMatch) {
        addrBlock = altMatch[1].trim();
      }
    }

    if (!addrBlock) {
      console.warn('[Amazon2DHL] Konnte keinen Adressblock (Liefern an) finden.');
      return null;
    }

    const rawLines = addrBlock
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !/^Liefern an:?$/i.test(l));

    let country = 'Deutschland';
    const countryMap = {
      deutschland: 'Deutschland',
      germany: 'Deutschland',
      de: 'Deutschland',
      deu: 'Deutschland',
      österreich: 'Österreich',
      austria: 'Österreich',
      at: 'Österreich',
      aut: 'Österreich',
      schweiz: 'Schweiz',
      switzerland: 'Schweiz',
      ch: 'Schweiz',
      che: 'Schweiz',
      niederlande: 'Niederlande',
      netherlands: 'Niederlande',
      nl: 'Niederlande',
      frankreich: 'Frankreich',
      france: 'Frankreich',
      fr: 'Frankreich',
      belgien: 'Belgien',
      belgium: 'Belgien',
      be: 'Belgien',
      italien: 'Italien',
      italy: 'Italien',
      it: 'Italien',
      spanien: 'Spanien',
      spain: 'Spanien',
      es: 'Spanien',
      polen: 'Polen',
      poland: 'Polen',
      pl: 'Polen',
      dänemark: 'Dänemark',
      denmark: 'Dänemark',
      dk: 'Dänemark'
    };

    if (rawLines.length > 0) {
      const lastLineNorm = rawLines[rawLines.length - 1].toLowerCase();
      if (countryMap[lastLineNorm]) {
        country = countryMap[lastLineNorm];
        rawLines.pop();
      }
    }

    let plz = '';
    let city = '';
    if (rawLines.length > 0) {
      const plzMatch = rawLines[rawLines.length - 1].match(/^(?:([A-Z]{1,2})[- ])?(\d{4,5})\s+(.+)$/);
      if (plzMatch) {
        plz = plzMatch[2].trim();
        city = plzMatch[3].replace(/\s+/g, ' ').trim();
        rawLines.pop();
      }
    }

    let street = '';
    let houseNumber = '';
    let isPackstation = false;
    let isFiliale = false;
    let packstationNumber = '';
    let postnummer = '';

    if (rawLines.length > 0) {
      const last = rawLines[rawLines.length - 1];
      const psMatch = last.match(/^Packstation\s*[:#]?\s*(\d+)/i);
      const pfMatch = last.match(/^(?:Postfiliale|Filiale)\s*[:#]?\s*(\d+)/i);

      if (psMatch) {
        isPackstation = true;
        street = 'Packstation';
        houseNumber = psMatch[1];
        packstationNumber = psMatch[1];
        rawLines.pop();
      } else if (pfMatch) {
        isFiliale = true;
        street = 'Postfiliale';
        houseNumber = pfMatch[1];
        rawLines.pop();
      } else {
        const streetRegex = /^(.+?)\s+([0-9]+(?:\s*[-\/]\s*[0-9]+)?(?:\s*[a-zA-Z\d\/]+)?)$/;
        const sMatch = last.match(streetRegex);
        if (sMatch) {
          street = sMatch[1].trim();
          houseNumber = sMatch[2].trim();
          rawLines.pop();
        } else {
          street = last.trim();
          rawLines.pop();
        }
      }
    }

    const remaining = [];
    for (const l of rawLines) {
      const pnExplicit = l.match(/^(?:Postnummer|Post-Nr\.?|Kundennummer)[:\s]+(\d{6,10})/i);
      const pnDigitsOnly = l.match(/^(\d{6,10})$/);
      if ((isPackstation || isFiliale) && pnExplicit) {
        postnummer = pnExplicit[1];
      } else if ((isPackstation || isFiliale) && pnDigitsOnly && !postnummer) {
        postnummer = pnDigitsOnly[1];
      } else {
        remaining.push(l);
      }
    }

    let name1 = '';
    let name2 = '';
    let name3 = '';
    let addressAddition = '';

    if (erfasstName) {
      for (let i = 0; i < remaining.length; i++) {
        if (
          remaining[i].toLowerCase() === erfasstName.toLowerCase() ||
          remaining[i].toLowerCase().includes(erfasstName.toLowerCase())
        ) {
          name1 = remaining[i];
          remaining.splice(i, 1);
          break;
        }
      }
    }

    if (!name1 && remaining.length > 0) {
      name1 = remaining.shift();
    }

    if (buyerOrderId && name1.includes(' - ')) {
      const [baseName, suffix] = name1.split(' - ');
      if (buyerOrderId.includes(suffix.trim())) {
        name1 = baseName.trim();
        if (!addressAddition) addressAddition = suffix.trim();
      }
    }

    if (remaining.length > 0) {
      let nxt = remaining.shift();
      if (buyerOrderId && nxt.includes(' - ')) {
        const [baseName, suffix] = nxt.split(' - ');
        if (buyerOrderId.includes(suffix.trim())) {
          nxt = baseName.trim();
          if (!addressAddition) addressAddition = suffix.trim();
        }
      }
      name2 = nxt;
    }

    if (remaining.length > 0) {
      name3 = remaining.shift();
    }

    if (remaining.length > 0) {
      const extra = remaining.join(' ');
      addressAddition = addressAddition ? `${addressAddition} ${extra}` : extra;
    }

    return {
      orderId,
      buyerOrderId,
      erfasstName,
      name1,
      name2,
      name3,
      addressAddition,
      street,
      houseNumber,
      plz,
      city,
      country,
      isPackstation,
      isFiliale,
      packstationNumber,
      postnummer
    };
  }

  // 3. DHL DOM FIELD MAPPING & AUTOFILL ENGINE
  const FIELD_RULES = {
    name1: {
      label: 'Name 1 / Firma',
      labelKeywords: ['name 1', 'name (empfänger)', 'empfänger name', 'vor- und nachname', 'firma / name', 'name', 'firma'],
      attrKeywords: ['name1', 'receivername1', 'recipientname1', 'receivername', 'empfaengername1', 'receiver.name1', 'name_1'],
      placeholders: ['name 1', 'name des empfängers', 'firma', 'vor- und nachname']
    },
    name2: {
      label: 'Name 2 / Zusatz',
      labelKeywords: ['name 2', 'zusatz', 'adresszusatz', 'name 2 (zusatz)', 'abteilung', 'c/o'],
      attrKeywords: ['name2', 'receivername2', 'recipientname2', 'empfaengername2', 'receiver.name2', 'name_2'],
      placeholders: ['name 2', 'zusatz', 'abteilung', 'c/o']
    },
    name3: {
      label: 'Name 3 / Weiterer Zusatz',
      labelKeywords: ['name 3', 'weiterer zusatz'],
      attrKeywords: ['name3', 'receivername3', 'recipientname3', 'empfaengername3', 'name_3'],
      placeholders: ['name 3']
    },
    street: {
      label: 'Strasse',
      labelKeywords: ['straße', 'strasse', 'str.', 'straßenname'],
      attrKeywords: ['streetname', 'street', 'strasse', 'receiverstreet', 'address.street', 'street_name', 'street-name'],
      placeholders: ['straße', 'strasse']
    },
    houseNumber: {
      label: 'Hausnummer',
      labelKeywords: ['hausnummer', 'haus-nr', 'hnr', 'hnr.', 'nr.'],
      attrKeywords: ['housenumber', 'streetnumber', 'hausnummer', 'hnr', 'receiverhousenumber', 'address.housenumber', 'house-number'],
      placeholders: ['nr', 'haus-nr', 'hausnummer', 'hnr']
    },
    addressAddition: {
      label: 'Adresszusatz',
      labelKeywords: ['adresszusatz', 'zusatz', 'wohnungsnr'],
      attrKeywords: ['addressaddition', 'adresszusatz', 'receiveraddressaddition', 'address.addition'],
      placeholders: ['adresszusatz', 'zusatz']
    },
    postalCode: {
      label: 'Postleitzahl / PLZ',
      labelKeywords: ['postleitzahl', 'plz'],
      attrKeywords: ['postalcode', 'postcode', 'plz', 'receiverpostalcode', 'address.postalcode', 'zip', 'zipcode'],
      placeholders: ['plz', 'postleitzahl']
    },
    city: {
      label: 'Ort / Stadt',
      labelKeywords: ['ort', 'stadt', 'wohnort', 'bestimmungsort'],
      attrKeywords: ['city', 'ort', 'receivercity', 'address.city', 'town'],
      placeholders: ['ort', 'stadt']
    },
    country: {
      label: 'Land',
      labelKeywords: ['land', 'bestimmungsland'],
      attrKeywords: ['country', 'land', 'receivercountry', 'address.country', 'countrycode'],
      placeholders: ['land']
    },
    customerReference: {
      label: 'Kundenreferenz 1 (Bestellnummer)',
      labelKeywords: ['kundenreferenz', 'sendungsreferenz', 'referenz', 'auftragsnummer', 'kundenreferenz 1', 'referenz 1'],
      attrKeywords: ['customerreference', 'shipmentreference', 'kundenreferenz', 'sendungsreferenz', 'reference', 'ref1', 'customerreference1'],
      placeholders: ['kundenreferenz', 'sendungsreferenz', 'referenz', 'bestellnummer']
    },
    customerReference2: {
      label: 'Kundenreferenz 2',
      labelKeywords: ['kundenreferenz 2', 'referenz 2'],
      attrKeywords: ['customerreference2', 'kundenreferenz2', 'ref2'],
      placeholders: ['kundenreferenz 2', 'referenz 2']
    },
    postnummer: {
      label: 'Postnummer',
      labelKeywords: ['postnummer', 'kundennummer'],
      attrKeywords: ['postnummer', 'postnumber', 'customernumber'],
      placeholders: ['postnummer']
    },
    packstation: {
      label: 'Packstation-Nr.',
      labelKeywords: ['packstation', 'packstationsnummer', 'nummer der packstation'],
      attrKeywords: ['packstation', 'packstationnumber'],
      placeholders: ['nummer', 'packstation']
    }
  };

  function setElementValue(element, value) {
    if (!element || value === undefined || value === null) return false;
    const strVal = String(value).trim();
    if (!strVal) return false;

    element.focus();

    if (element.tagName === 'SELECT') {
      let matched = false;
      for (const opt of element.options) {
        if (
          opt.value.toLowerCase() === strVal.toLowerCase() ||
          opt.text.toLowerCase().includes(strVal.toLowerCase()) ||
          (strVal === 'Deutschland' && (opt.value === 'DE' || opt.value === 'DEU')) ||
          (strVal === 'Österreich' && (opt.value === 'AT' || opt.value === 'AUT')) ||
          (strVal === 'Schweiz' && (opt.value === 'CH' || opt.value === 'CHE'))
        ) {
          element.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) element.value = strVal;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.blur();
      highlightField(element);
      return true;
    }

    const proto = Object.getPrototypeOf(element);
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(element, strVal);
    } else {
      element.value = strVal;
    }

    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

    highlightField(element);
    return true;
  }

  function highlightField(el) {
    try {
      const prevTransition = el.style.transition;
      const prevOutline = el.style.outline;
      const prevBg = el.style.backgroundColor;

      el.style.transition = 'all 0.3s ease';
      el.style.outline = '2px solid #28a745';
      el.style.backgroundColor = '#f0fff4';

      setTimeout(() => {
        el.style.outline = prevOutline;
        el.style.backgroundColor = prevBg;
        el.style.transition = prevTransition;
      }, 1500);
    } catch (e) {}
  }

  function findFieldInDoc(fieldKey, doc) {
    const config = FIELD_RULES[fieldKey];
    if (!config || !doc) return null;

    const allInputs = Array.from(doc.querySelectorAll('input:not([type="hidden"]), select, textarea'));

    for (const el of allInputs) {
      if (!isElementVisible(el)) continue;
      const id = (el.id || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const fcn = (el.getAttribute('formcontrolname') || '').toLowerCase();
      const dataTest = (el.getAttribute('data-test') || el.getAttribute('data-id') || '').toLowerCase();

      for (const kw of config.attrKeywords) {
        if (id === kw || name === kw || fcn === kw || dataTest === kw) return el;
      }
    }

    for (const el of allInputs) {
      if (!isElementVisible(el)) continue;
      const id = (el.id || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const fcn = (el.getAttribute('formcontrolname') || '').toLowerCase();
      const dataTest = (el.getAttribute('data-test') || el.getAttribute('data-id') || '').toLowerCase();

      for (const kw of config.attrKeywords) {
        if (id.includes(kw) || name.includes(kw) || fcn.includes(kw) || dataTest.includes(kw)) {
          if (kw === 'name1' && (id.includes('name2') || name.includes('name2') || fcn.includes('name2'))) continue;
          return el;
        }
      }
    }

    const allLabels = Array.from(doc.querySelectorAll('label'));
    for (const label of allLabels) {
      const labelText = (label.textContent || '').trim().toLowerCase();
      for (const lkw of config.labelKeywords) {
        const regex = new RegExp(`(^|\\b)${lkw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`, 'i');
        if (regex.test(labelText)) {
          if (label.htmlFor) {
            const el = doc.getElementById(label.htmlFor);
            if (el && isElementVisible(el)) return el;
          }
          const innerInput = label.querySelector('input:not([type="hidden"]), select');
          if (innerInput && isElementVisible(innerInput)) return innerInput;

          const parent = label.closest('.form-group, .form-field, .row, [class*="field"], [class*="form-item"]') || label.parentElement;
          if (parent) {
            const siblingInput = parent.querySelector('input:not([type="hidden"]), select');
            if (siblingInput && isElementVisible(siblingInput)) return siblingInput;
          }
        }
      }
    }

    for (const el of allInputs) {
      if (!isElementVisible(el)) continue;
      const ph = (el.placeholder || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      for (const pkw of config.placeholders) {
        if (ph.includes(pkw) || aria.includes(pkw)) return el;
      }
    }

    return null;
  }

  function isElementVisible(el) {
    if (!el) return false;
    try {
      if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch (e) {
      return true;
    }
  }

  function executeAutofill(parsedData) {
    if (!parsedData) return { success: false, filledCount: 0 };

    const targetDocs = [];
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          targetDocs.push(iframe.contentDocument);
        }
      } catch (e) {}
    }
    targetDocs.push(document);

    const mapping = [
      { key: 'name1', val: parsedData.name1 },
      { key: 'name2', val: parsedData.name2 },
      { key: 'name3', val: parsedData.name3 },
      { key: 'street', val: parsedData.street },
      { key: 'houseNumber', val: parsedData.houseNumber },
      { key: 'addressAddition', val: parsedData.addressAddition },
      { key: 'postalCode', val: parsedData.plz },
      { key: 'city', val: parsedData.city },
      { key: 'country', val: parsedData.country },
      { key: 'customerReference', val: parsedData.orderId },
      { key: 'customerReference2', val: parsedData.buyerOrderId },
      { key: 'postnummer', val: parsedData.postnummer },
      { key: 'packstation', val: parsedData.packstationNumber }
    ];

    let filledCount = 0;

    for (const doc of targetDocs) {
      if (parsedData.isPackstation) {
        const psRadio = doc.querySelector('input[type="radio"][value*="PACKSTATION" i], input[type="radio"]#packstation');
        if (psRadio) {
          psRadio.click();
          psRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      for (const item of mapping) {
        if (!item.val) continue;
        const fieldEl = findFieldInDoc(item.key, doc);
        if (fieldEl) {
          const success = setElementValue(fieldEl, item.val);
          if (success) {
            filledCount++;
          }
        }
      }

      if (filledCount > 0) break;
    }

    return {
      success: filledCount > 0,
      filledCount
    };
  }

  // 4. BENUTZEROBERFLAECHE IM HAUPTFENSTER
  let parsedState = null;

  function createWidget() {
    if (document.getElementById('amazon2dhl-widget')) return;

    const style = document.createElement('style');
    style.textContent = `
      #amazon2dhl-widget {
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        width: 360px !important;
        background: #ffffff !important;
        border-radius: 10px !important;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28) !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
        font-size: 13px !important;
        color: #222 !important;
        z-index: 2147483647 !important;
        overflow: hidden !important;
        border: 2px solid #ffcc00 !important;
        transition: width 0.2s, height 0.2s !important;
      }
      #amazon2dhl-widget.minimized {
        width: 170px !important;
        height: 42px !important;
      }
      #amazon2dhl-widget.minimized .a2d-body {
        display: none !important;
      }
      .a2d-header {
        background: #ffcc00 !important;
        color: #111 !important;
        padding: 9px 12px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        font-weight: 700 !important;
        cursor: grab !important;
        user-select: none !important;
        border-bottom: 2px solid #d40511 !important;
      }
      .a2d-header-title {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        font-size: 13px !important;
      }
      .a2d-logo-badge {
        background: #d40511 !important;
        color: #fff !important;
        padding: 2px 6px !important;
        border-radius: 4px !important;
        font-size: 10px !important;
        letter-spacing: 0.5px !important;
      }
      .a2d-btn-icon {
        background: transparent !important;
        border: none !important;
        cursor: pointer !important;
        font-size: 14px !important;
        padding: 2px 6px !important;
        border-radius: 4px !important;
        color: #111 !important;
        font-weight: bold !important;
      }
      .a2d-btn-icon:hover {
        background: rgba(0,0,0,0.1) !important;
      }
      .a2d-body {
        padding: 12px !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 10px !important;
        max-height: 80vh !important;
        overflow-y: auto !important;
      }
      .a2d-dropzone {
        border: 2px dashed #ffcc00 !important;
        border-radius: 8px !important;
        padding: 16px 10px !important;
        text-align: center !important;
        background: #fffdf2 !important;
        cursor: pointer !important;
        transition: all 0.2s !important;
      }
      .a2d-dropzone:hover, .a2d-dropzone.dragover {
        border-color: #d40511 !important;
        background: #fff8e1 !important;
      }
      .a2d-dropzone-text {
        font-weight: 600 !important;
        color: #333 !important;
        font-size: 13px !important;
      }
      .a2d-dropzone-sub {
        font-size: 11px !important;
        color: #777 !important;
        margin-top: 3px !important;
      }
      .a2d-divider {
        display: flex !important;
        align-items: center !important;
        text-align: center !important;
        color: #888 !important;
        font-size: 11px !important;
      }
      .a2d-divider::before, .a2d-divider::after {
        content: '' !important;
        flex: 1 !important;
        border-bottom: 1px solid #e2e8f0 !important;
      }
      .a2d-divider:not(:empty)::before {
        margin-right: .5em !important;
      }
      .a2d-divider:not(:empty)::after {
        margin-left: .5em !important;
      }
      .a2d-btn-tab {
        background: #f4f6f8 !important;
        color: #111 !important;
        border: 1px solid #cbd5e0 !important;
        padding: 8px 10px !important;
        border-radius: 6px !important;
        font-weight: 600 !important;
        font-size: 12px !important;
        cursor: pointer !important;
        width: 100% !important;
        text-align: center !important;
        transition: background 0.15s, border-color 0.15s !important;
      }
      .a2d-btn-tab:hover {
        background: #e2e8f0 !important;
        border-color: #a0aec0 !important;
      }
      .a2d-preview-card {
        background: #f8f9fa !important;
        border: 1px solid #e2e8f0 !important;
        border-radius: 8px !important;
        padding: 10px !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 5px !important;
      }
      .a2d-preview-row {
        display: flex !important;
        font-size: 12px !important;
      }
      .a2d-preview-label {
        width: 90px !important;
        color: #666 !important;
        font-weight: 600 !important;
      }
      .a2d-preview-val {
        flex: 1 !important;
        color: #111 !important;
        word-break: break-word !important;
      }
      .a2d-status {
        padding: 8px 10px !important;
        border-radius: 6px !important;
        font-size: 12px !important;
        display: none !important;
      }
      .a2d-status.success {
        display: block !important;
        background: #d4edda !important;
        color: #155724 !important;
        border: 1px solid #c3e6cb !important;
      }
      .a2d-status.warning {
        display: block !important;
        background: #fff3cd !important;
        color: #856404 !important;
        border: 1px solid #ffeeba !important;
      }
    `;
    document.head.appendChild(style);

    const widget = document.createElement('div');
    widget.id = 'amazon2dhl-widget';
    widget.innerHTML = `
      <div class="a2d-header" id="a2d-header">
        <div class="a2d-header-title">
          <span>Amazon zu DHL</span>
          <span class="a2d-logo-badge">AutoFill</span>
        </div>
        <div class="a2d-header-btns">
          <button class="a2d-btn-icon" id="a2d-btn-min" title="Minimieren / Wiederherstellen">_</button>
        </div>
      </div>
      <div class="a2d-body">
        <div class="a2d-dropzone" id="a2d-dropzone">
          <div class="a2d-dropzone-text">Amazon PDF hier ablegen</div>
          <div class="a2d-dropzone-sub">oder klicken zum Auswaehlen</div>
          <input type="file" id="a2d-file-input" accept="application/pdf" style="display: none;">
        </div>

        <div class="a2d-divider">oder</div>

        <button class="a2d-btn-tab" id="a2d-btn-sync-tab">Amazon-Tab uebernehmen</button>

        <div id="a2d-status-box" class="a2d-status"></div>

        <div id="a2d-preview-card" class="a2d-preview-card" style="display: none;">
          <div class="a2d-preview-row">
            <span class="a2d-preview-label">Name 1:</span>
            <span class="a2d-preview-val" id="a2d-pv-name1">-</span>
          </div>
          <div class="a2d-preview-row" id="a2d-pv-row-name2" style="display: none;">
            <span class="a2d-preview-label">Name 2:</span>
            <span class="a2d-preview-val" id="a2d-pv-name2">-</span>
          </div>
          <div class="a2d-preview-row">
            <span class="a2d-preview-label">Strasse:</span>
            <span class="a2d-preview-val" id="a2d-pv-street">-</span>
          </div>
          <div class="a2d-preview-row">
            <span class="a2d-preview-label">PLZ / Ort:</span>
            <span class="a2d-preview-val" id="a2d-pv-city">-</span>
          </div>
          <div class="a2d-preview-row">
            <span class="a2d-preview-label">Land:</span>
            <span class="a2d-preview-val" id="a2d-pv-country">Deutschland</span>
          </div>
          <div class="a2d-preview-row">
            <span class="a2d-preview-label">Bestell-Nr.:</span>
            <span class="a2d-preview-val" id="a2d-pv-order">-</span>
          </div>
        </div>
      </div>
    `;

    (document.body || document.documentElement).appendChild(widget);
    setupWidgetEvents(widget);
  }

  function setupWidgetEvents(widget) {
    const dropzone = widget.querySelector('#a2d-dropzone');
    const fileInput = widget.querySelector('#a2d-file-input');
    const syncTabBtn = widget.querySelector('#a2d-btn-sync-tab');
    const minBtn = widget.querySelector('#a2d-btn-min');

    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) handlePdfFile(file);
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handlePdfFile(e.dataTransfer.files[0]);
      }
    });

    // Drop anywhere auf der gesamten Seite
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
          e.preventDefault();
          handlePdfFile(file);
        }
      }
    });

    // Klick auf "Amazon-Tab uebernehmen"
    syncTabBtn.addEventListener('click', () => {
      showStatus(false, 'Pruefe offenen Amazon-Tab...');

      if (typeof GM_setValue === 'function') {
        GM_setValue('amazon2dhl_ping', Date.now());
      }

      setTimeout(() => {
        const order = typeof GM_getValue === 'function' ? GM_getValue('latest_amazon_order') : null;
        if (!order || !order.text) {
          showStatus(false, 'Kein offener Amazon Lieferschein-Tab gefunden. Bitte den Amazon-Tab im Browser oeffnen oder neu laden.', true);
          return;
        }

        const ageMinutes = Math.round((Date.now() - (order.timestamp || 0)) / 60000);
        if (ageMinutes > 1440) {
          showStatus(false, 'Die gefundenen Amazon-Daten sind aelter als 24 Stunden. Bitte den Amazon-Tab neu laden.', true);
          return;
        }

        processExtractedText(order.text);
      }, 70);
    });

    minBtn.addEventListener('click', () => {
      widget.classList.toggle('minimized');
      minBtn.textContent = widget.classList.contains('minimized') ? '+' : '_';
    });
  }

  function runAutofill(data) {
    showStatus(false, 'Uebertrage Daten in das DHL-Formular...');
    const res = executeAutofill(data);
    if (res && res.success) {
      showStatus(true, `${res.filledCount} Felder fuer Bestellung ${data.orderId || ''} eingetragen.`);
    } else {
      showStatus(false, 'DHL-Formularfelder noch nicht geladen oder nicht gefunden.', true);
    }
  }

  async function handlePdfFile(fileOrBuffer) {
    showStatus(false, 'Lese PDF aus...');
    try {
      const fullText = await extractTextFromPdf(fileOrBuffer);
      processExtractedText(fullText);
    } catch (err) {
      console.error('[Amazon2DHL] Fehler beim PDF-Lesen:', err);
      showStatus(false, 'Fehler beim Auslesen des PDFs: ' + err.message, true);
    }
  }

  function processExtractedText(text) {
    const data = parseAmazonText(text);
    if (!data) {
      showStatus(false, 'Keine gueltigen Amazon-Bestelldaten gefunden.', true);
      return;
    }

    parsedState = data;
    updatePreview(data);

    // Formular sofort automatisch ausfuellen
    runAutofill(data);
  }

  function updatePreview(data) {
    const widget = document.getElementById('amazon2dhl-widget');
    if (!widget) return;

    widget.querySelector('#a2d-pv-name1').textContent = data.name1 || '-';
    if (data.name2) {
      widget.querySelector('#a2d-pv-row-name2').style.display = 'flex';
      widget.querySelector('#a2d-pv-name2').textContent = data.name2;
    } else {
      widget.querySelector('#a2d-pv-row-name2').style.display = 'none';
    }

    widget.querySelector('#a2d-pv-street').textContent = `${data.street} ${data.houseNumber}`.trim() || '-';
    widget.querySelector('#a2d-pv-city').textContent = `${data.plz} ${data.city}`.trim() || '-';
    widget.querySelector('#a2d-pv-country').textContent = data.country || 'Deutschland';
    widget.querySelector('#a2d-pv-order').textContent = data.orderId || '-';

    widget.querySelector('#a2d-preview-card').style.display = 'flex';
  }

  function showStatus(isSuccess, message, isWarning = false) {
    const box = document.getElementById('a2d-status-box');
    if (!box) return;
    if (!message) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.className = isSuccess ? 'a2d-status success' : isWarning ? 'a2d-status warning' : 'a2d-status';
    box.textContent = message;
  }

  // 5. INITIALISIERUNG
  function init() {
    createWidget();

    const observer = new MutationObserver(() => {
      if (!document.getElementById('amazon2dhl-widget')) {
        createWidget();
      }
    });

    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    console.log('[Amazon2DHL] Userscript v1.7.0 aktiv im Hauptfenster.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
