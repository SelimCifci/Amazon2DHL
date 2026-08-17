// ==UserScript==
// @name         Amazon2DHL
// @namespace    https://geschaeftskunden.dhl.de/
// @version      1.0
// @description  Autofill DHL Geschäftskundenportal shipment details from Amazon packing slips
// @author       Selim Cifci (Antigravity)
// @match        https://geschaeftskunden.dhl.de/*
// @match        *://sellercentral.amazon.de/orders/packing-slip*
// @match        *://sellercentral-europe.amazon.com/orders/packing-slip*
// @match        *://sellercentral.amazon.com/orders/packing-slip*
// @match        *://*.amazon.*/orders/packing-slip*
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    }

    // =========================================================================
    // MODULE 1: AUTO-CAPTURE ON AMAZON PACKING SLIP WINDOW
    // =========================================================================
    if (window.location.hostname.includes('amazon')) {
        function captureAmazonOrder() {
            const rawText = document.body.innerText || '';
            const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
            const parsedData = parseAddressFromLines(rawLines);

            if (parsedData && (parsedData.name1 || parsedData.street)) {
                GM_setValue('latest_amazon_order', JSON.stringify({
                    ...parsedData,
                    timestamp: Date.now()
                }));
                console.log('[Amazon2DHL] Successfully captured from Amazon window:', parsedData);

                // Show confirmation badge in top right of Amazon window
                showAmazonBadge(`Erfasst fuer DHL: ${parsedData.name1 || parsedData.name2}`);
            }
        }

        function showAmazonBadge(text) {
            if (document.getElementById('adh-amazon-badge')) return;
            const badge = document.createElement('div');
            badge.id = 'adh-amazon-badge';
            badge.textContent = text;
            Object.assign(badge.style, {
                position: 'fixed',
                top: '10px',
                right: '10px',
                backgroundColor: '#ffcc00',
                color: '#d40511',
                border: '1px solid #d40511',
                padding: '6px 12px',
                borderRadius: '4px',
                fontWeight: 'bold',
                fontSize: '12px',
                zIndex: '999999',
                boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                          fontFamily: 'Arial, sans-serif'
            });
            document.body.appendChild(badge);
        }

        // Run immediately or when loaded
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            captureAmazonOrder();
        } else {
            window.addEventListener('DOMContentLoaded', captureAmazonOrder);
            window.addEventListener('load', captureAmazonOrder);
        }
        return;
    }

    // =========================================================================
    // MODULE 2: DHL GKP USER INTERFACE
    // =========================================================================
    function injectUI() {
        if (window.top !== window.self) return;
        if (document.getElementById('dhl-amazon-import-box')) return;

        const widget = document.createElement('div');
        widget.id = 'dhl-amazon-import-box';
        widget.innerHTML = `
        <div id="adh-header" style="display:flex; justify-content:space-between; align-items:center; font-weight:bold; font-size:12px; color:#d40511; margin-bottom:8px; cursor:pointer;">
        <span>Amazon PDF Import</span>
        <span id="adh-toggle" style="cursor:pointer; font-size:14px; color:#d40511; font-weight:bold; width:20px; text-align:right; user-select:none;" title="Minimieren / Erweitern">▾</span>
        </div>
        <div id="adh-body">
        <div id="adh-dropzone" style="border: 1px dashed #d40511; border-radius: 4px; padding: 12px; text-align: center; background: #fffdf0; cursor: pointer;">
        <div style="font-size: 12px; font-weight: bold; color: #111;">PDF hier ablegen</div>
        <div style="font-size: 10px; color: #666; margin-top: 2px;">oder klicken zum Auswaehlen</div>
        <input type="file" id="adh-file-input" accept="application/pdf" style="display:none;" />
        </div>

        <button id="adh-btn-opentab" type="button" style="width:100%; margin-top:6px; padding:6px; background:#ffffff; border:1px solid #999999; border-radius:4px; font-size:11px; cursor:pointer; color:#111;">
        Aus geoffnetem Amazon-Tab laden
        </button>

        <div id="adh-status" style="margin-top:8px; font-size:11px; color:#222; display:none; max-height:180px; overflow-y:auto; line-height:1.4; border-top:1px solid #e0c800; padding-top:6px;"></div>
        </div>
        `;

        Object.assign(widget.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '260px',
            backgroundColor: '#ffcc00',
            border: '1px solid #d40511',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                      padding: '10px',
                      zIndex: '999999',
                      fontFamily: 'Arial, sans-serif',
                      userSelect: 'none'
        });

        document.body.appendChild(widget);

        const dropzone = widget.querySelector('#adh-dropzone');
        const fileInput = widget.querySelector('#adh-file-input');
        const openTabBtn = widget.querySelector('#adh-btn-opentab');
        const toggleBtn = widget.querySelector('#adh-toggle');
        const header = widget.querySelector('#adh-header');
        const bodyDiv = widget.querySelector('#adh-body');

        dropzone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) processPDFFile(e.target.files[0]);
        });

            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.style.background = '#ffe57f';
            });
            dropzone.addEventListener('dragleave', () => {
                dropzone.style.background = '#fffdf0';
            });
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.style.background = '#fffdf0';
                if (e.dataTransfer.files.length > 0) {
                    processPDFFile(e.dataTransfer.files[0]);
                }
            });

            openTabBtn.addEventListener('click', () => {
                const cachedRaw = GM_getValue('latest_amazon_order', null);
                if (!cachedRaw) {
                    showStatus('Keine Daten gefunden. Bitte oeffnen Sie die Amazon-Lieferschein-Vorschau in einem Tab.', true);
                    return;
                }
                const data = JSON.parse(cachedRaw);
                applyExtractedData(data);
            });

            header.addEventListener('click', () => {
                if (bodyDiv.style.display === 'none') {
                    bodyDiv.style.display = 'block';
                    toggleBtn.textContent = '▾';
                } else {
                    bodyDiv.style.display = 'none';
                    toggleBtn.textContent = '▴';
                }
            });
    }

    // =========================================================================
    // MODULE 3: COORDINATE-AWARE PDF TEXT EXTRACTION
    // =========================================================================
    async function processPDFFile(file) {
        showStatus('Lese PDF-Datei...', false);

        try {
            const arrayBuffer = await file.arrayBuffer();
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            const pdf = await loadingTask.promise;
            let allLines = [];

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                const pageLines = extractLinesFromPage(textContent);
                allLines = allLines.concat(pageLines);
            }

            console.log('[Amazon2DHL] Extracted Lines from PDF:', allLines);
            const data = parseAddressFromLines(allLines);

            if (!data.name1 && !data.street) {
                showStatus('Fehler: Adresse konnte im PDF nicht erkannt werden.', true);
                return;
            }

            applyExtractedData(data);

        } catch (err) {
            console.error('[Amazon2DHL] Parsing error:', err);
            showStatus('Fehler beim Verarbeiten: ' + err.message, true);
        }
    }

    function extractLinesFromPage(textContent) {
        if (!textContent || !textContent.items || textContent.items.length === 0) return [];

        const items = textContent.items.slice().sort((a, b) => {
            const yDiff = b.transform[5] - a.transform[5];
            if (Math.abs(yDiff) > 3) return yDiff;
            return a.transform[4] - b.transform[4];
        });

        const lines = [];
        let currentY = null;
        let currentLine = '';

        for (const item of items) {
            const text = item.str;
            if (!text || text.trim() === '') continue;

            const y = item.transform[5];

            if (currentY === null || Math.abs(y - currentY) > 3) {
                if (currentLine.trim()) lines.push(currentLine.trim());
                currentLine = text;
                currentY = y;
            } else {
                currentLine += (currentLine.endsWith(' ') || text.startsWith(' ') ? '' : ' ') + text;
            }
        }

        if (currentLine.trim()) lines.push(currentLine.trim());
        return lines;
    }

    // =========================================================================
    // MODULE 4: ANCHOR-BASED ADDRESS PARSER
    // =========================================================================
    function parseAddressFromLines(lines) {
        const result = {
            name1: '',
            name2: '',
            street: '',
            streetNumber: '',
            zip: '',
            city: '',
            orderId: ''
        };

        // 1. Find Order ID
        for (const line of lines) {
            const orderMatch = line.match(/Bestellnummer:\s*([0-9]{3}-[0-9]{7}-[0-9]{7})/i);
            if (orderMatch) {
                result.orderId = orderMatch[1].trim();
                break;
            }
        }

        // 2. Locate "Liefern an:" or "Lieferanschrift:" header
        let startIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/^(Liefern an:|Lieferanschrift:)$/i.test(lines[i]) || lines[i].toLowerCase().startsWith('liefern an:')) {
                startIndex = i + 1;
                break;
            }
        }

        const searchLines = startIndex !== -1 ? lines.slice(startIndex, startIndex + 6) : lines;

        // 3. ANCHOR: Find 5-digit PLZ + City line (e.g. "42781 Haan" or "81245 München")
        let zipCityIndex = -1;
        for (let i = 0; i < searchLines.length; i++) {
            const plzMatch = searchLines[i].match(/^(\d{5})\s+(.+)$/);
            if (plzMatch) {
                result.zip = plzMatch[1].trim();
                result.city = plzMatch[2].trim();
                zipCityIndex = i;
                break;
            }
        }

        if (zipCityIndex === -1) {
            console.warn('[Amazon2DHL] Postal code line not found in candidate lines:', searchLines);
            return result;
        }

        // 4. STREET LINE: The line immediately before the PLZ line
        if (zipCityIndex >= 1) {
            const streetLine = searchLines[zipCityIndex - 1];
            const streetMatch = streetLine.match(/^(.*?)\s+(\d+[\w\s/-]*)$/);
            if (streetMatch) {
                result.street = streetMatch[1].trim();
                result.streetNumber = streetMatch[2].trim();
            } else {
                result.street = streetLine.trim();
                result.streetNumber = '';
            }
        }

        // 5. NAME LINES: All lines before the street line
        const nameCandidates = searchLines.slice(0, Math.max(0, zipCityIndex - 1));

        if (nameCandidates.length === 1) {
            result.name1 = nameCandidates[0].trim();
            result.name2 = '';
        } else if (nameCandidates.length >= 2) {
            result.name2 = nameCandidates[0].trim(); // Person
            result.name1 = nameCandidates[1].trim(); // Company
        }

        return result;
    }

    // =========================================================================
    // MODULE 5: EXACT DHL FORM AUTOFILL
    // =========================================================================
    function getDHLTargetDocument() {
        const iframes = document.querySelectorAll('iframe');
        for (const frame of iframes) {
            try {
                if (frame.contentDocument && frame.contentDocument.getElementById('receiver.name1')) {
                    return frame.contentDocument;
                }
            } catch (e) {}
        }
        return document;
    }

    function setFieldValue(inputElement, value) {
        if (!inputElement || value === undefined || value === null) return false;

        inputElement.focus();

        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
            nativeSetter.call(inputElement, value);
        } else {
            inputElement.value = value;
        }

        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
        inputElement.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        inputElement.blur();
        return true;
    }

    function applyExtractedData(data) {
        const doc = getDHLTargetDocument();
        let populatedCount = 0;

        const streetRadio = doc.getElementById('receiver-DEU_STREET');
        if (streetRadio && !streetRadio.checked) {
            streetRadio.click();
        }

        if (setFieldValue(doc.getElementById('receiver.name1'), data.name1)) populatedCount++;
        if (setFieldValue(doc.getElementById('receiver.name2'), data.name2)) populatedCount++;
        if (setFieldValue(doc.getElementById('receiver.street'), data.street)) populatedCount++;
        if (setFieldValue(doc.getElementById('receiver.streetNumber'), data.streetNumber)) populatedCount++;
        if (setFieldValue(doc.getElementById('receiver.plz'), data.zip)) populatedCount++;
        if (setFieldValue(doc.getElementById('receiver.city'), data.city)) populatedCount++;

        if (data.orderId) {
            if (setFieldValue(doc.getElementById('shipment-reference'), data.orderId)) populatedCount++;
            if (setFieldValue(doc.getElementById('receiver-reference'), data.orderId)) populatedCount++;
        }

        showStatus(`
        <b>Daten erfolgreich eingefuegt:</b><br>
        Name 1: ${data.name1 || '-'}<br>
        Name 2: ${data.name2 || '-'}<br>
        Strasse: ${data.street} ${data.streetNumber}<br>
        PLZ/Ort: ${data.zip} ${data.city}<br>
        Referenz: ${data.orderId || '-'}<br>
        <span style="color:#555;">(${populatedCount} Felder befuellt)</span>
        `, false);
    }

    function showStatus(htmlMessage, isError) {
        const statusDiv = document.getElementById('adh-status');
        if (!statusDiv) return;
        statusDiv.style.display = 'block';
        statusDiv.style.color = isError ? '#a00' : '#111';
        statusDiv.innerHTML = htmlMessage;
    }

    // =========================================================================
    // MODULE 6: INITIALIZATION
    // =========================================================================
    setInterval(() => {
        if (window.location.hostname.includes('geschaeftskunden.dhl.de')) {
            injectUI();
        }
    }, 1000);

})();
