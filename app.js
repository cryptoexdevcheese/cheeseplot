/*
 * CheesePlot - Sovereign Cadastral Boundary Consensus & RTK Surveyor Client
 * Core Logic and Calculations Controller
 */

document.addEventListener('DOMContentLoaded', () => {
    // --- State Variables ---
    let coordinates = [];         // Array of {lat, lng} points
    let neighborLots = [];        // Mock loaded neighbor properties
    let walletAddress = null;
    let rtkFixActive = false;     // Color indicators trigger
    let nmeaSectorInterval = null;// Walks simulated rover path
    let ledgerDatabase = [];
    
    // User Roles Consensus signatures state
    let neighborSignatures = {};  // address => bool
    let isSurveyorVerified = false;
    let isLguApproved = false;
    
    // Mock Base Reference for localized tangent projection (Manila center area)
    const latRefDefault = 14.5995;
    const lonRefDefault = 120.9842;
    
    // --- DOM Elements ---
    const canvas = document.getElementById('cadastral-canvas');
    const ctx = canvas.getContext('2d');
    
    const walletAddressDisplay = document.getElementById('wallet-address-display');
    const btnConnectWallet = document.getElementById('btn-connect-wallet');
    
    const phoneInput = document.getElementById('sms-phone-number');
    const btnRequestSms = document.getElementById('btn-request-sms');
    const smsOtpContainer = document.getElementById('sms-otp-container');
    const otpInput = document.getElementById('sms-otp-input');
    const btnVerifyOtp = document.getElementById('btn-verify-otp');
    
    const roverLinkStatus = document.getElementById('rover-link-status');
    const rtkPrecisionStatus = document.getElementById('rtk-precision-status');
    const roverSatsCount = document.getElementById('rover-sats-count');
    const roverRmsError = document.getElementById('rover-rms-error');
    const btnConnectRover = document.getElementById('btn-connect-rover');
    
    const ntripCaster = document.getElementById('ntrip-caster');
    const ntripMountpoint = document.getElementById('ntrip-mountpoint');
    const btnConnectNtrip = document.getElementById('btn-connect-ntrip');
    
    const btnToggleGrid = document.getElementById('btn-toggle-grid');
    const btnClearPlot = document.getElementById('btn-clear-plot');
    
    const encroachmentWarning = document.getElementById('encroachment-warning');
    const encroachmentDesc = document.getElementById('encroachment-desc');
    const btnSimulateRoverTrack = document.getElementById('btn-simulate-rover-track');
    const btnMockOverlap = document.getElementById('btn-mock-overlap');
    
    const metricArea = document.getElementById('metric-area');
    const metricPerimeter = document.getElementById('metric-perimeter');
    const coordinatesLogList = document.getElementById('coordinates-log-list');
    
    const neighborWalletsInput = document.getElementById('neighbor-wallets-input');
    const neighborSignaturesList = document.getElementById('neighbor-signatures-list');
    
    const lguNotaryAddress = document.getElementById('lgu-notary-address');
    const btnLguApprove = document.getElementById('btn-lgu-approve');
    const surveyorNotaryAddress = document.getElementById('surveyor-notary-address');
    const btnSurveyorVerify = document.getElementById('btn-surveyor-verify');
    
    const btnSubmitRegistry = document.getElementById('btn-submit-registry');
    const ledgerHistoryRows = document.getElementById('ledger-history-rows');
    const ledgerSearchInput = document.getElementById('ledger-search-input');

    // Canvas rendering scaling/offsets
    let zoomLevel = 350000;
    let snapToGrid = false;
    let gridSpacing = 20;

    // Set initial size
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function resizeCanvas() {
        const rect = canvas.parentNode.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        drawMap();
    }

    // --- 1. Geodetic Projection Math ---
    function projectToMeters(lat, lng, lat0 = latRefDefault, lon0 = lonRefDefault) {
        const rLat0 = lat0 * Math.PI / 180;
        const y = (lat - lat0) * 111132.95;
        const x = (lng - lon0) * 111319.9 * Math.cos(rLat0);
        return { x, y };
    }

    function projectToLatLng(x, y, lat0 = latRefDefault, lon0 = lonRefDefault) {
        const rLat0 = lat0 * Math.PI / 180;
        const lat = lat0 + (y / 111132.95);
        const lng = lon0 + (x / (111319.9 * Math.cos(rLat0)));
        return { lat, lng };
    }

    // Parse standard GNGGA NMEA sentence into decimal degrees coordinate
    function parseGNGGA(sentence) {
        if (!sentence || !sentence.startsWith('$') || !sentence.includes('GGA')) {
            return null;
        }

        const parts = sentence.split(',');
        if (parts.length < 15) return null;

        const rawLat = parts[2];
        const latDirection = parts[3];
        const rawLon = parts[4];
        const lonDirection = parts[5];
        const fixQuality = parseInt(parts[6]);
        const satellites = parseInt(parts[7]);
        const hdop = parseFloat(parts[8]);

        if (!rawLat || !rawLon) return null;

        // Parse Latitude (DDMM.MMMM)
        const latDegrees = parseFloat(rawLat.substring(0, 2));
        const latMinutes = parseFloat(rawLat.substring(2));
        let latDecimal = latDegrees + (latMinutes / 60);
        if (latDirection === 'S') latDecimal = -latDecimal;

        // Parse Longitude (DDDMM.MMMM)
        const lonDegrees = parseFloat(rawLon.substring(0, 3));
        const lonMinutes = parseFloat(rawLon.substring(3));
        let lonDecimal = lonDegrees + (lonMinutes / 60);
        if (lonDirection === 'W') lonDecimal = -lonDecimal;

        return {
            lat: latDecimal,
            lng: lonDecimal,
            fixQuality: fixQuality,
            satellites: satellites,
            hdop: hdop
        };
    }

    // Check if the coordinate boundary crosses itself (non-simple polygon)
    function hasSelfIntersection(coords) {
        const n = coords.length;
        if (n < 4) return false;

        for (let i = 0; i < n; i++) {
            const a1 = coords[i];
            const a2 = coords[(i + 1) % n];

            for (let j = i + 2; j < n; j++) {
                if ((j + 1) % n === i) continue; // Skip adjacent edges

                const b1 = coords[j];
                const b2 = coords[(j + 1) % n];

                if (checkLineIntersection(a1, a2, b1, b2)) {
                    return true;
                }
            }
        }
        return false;
    }

    // --- 2. Shoelace Area & Perimeter Calculations ---
    function updateCalculations() {
        if (coordinates.length < 3) {
            metricArea.textContent = "0.00";
            metricPerimeter.textContent = "0.00";
            btnSubmitRegistry.disabled = true;
            return;
        }

        // Project coordinate array to meters
        const meters = coordinates.map(c => projectToMeters(c.lat, c.lng));
        const n = meters.length;

        // Apply Gauss's Shoelace Area algorithm
        let areaSum = 0;
        for (let i = 0; i < n; i++) {
            const nextIdx = (i + 1) % n;
            areaSum += meters[i].x * meters[nextIdx].y;
            areaSum -= meters[nextIdx].x * meters[i].y;
        }
        const area = Math.abs(areaSum) / 2;

        // Apply Perimeter sum distance
        let perimeter = 0;
        for (let i = 0; i < n; i++) {
            const nextIdx = (i + 1) % n;
            const dx = meters[nextIdx].x - meters[i].x;
            const dy = meters[nextIdx].y - meters[i].y;
            perimeter += Math.sqrt(dx * dx + dy * dy);
        }

        const selfIntersect = hasSelfIntersection(coordinates);
        if (selfIntersect) {
            metricArea.textContent = "Overlap!";
            metricArea.style.color = "var(--red-alert)";
        } else {
            metricArea.textContent = area.toFixed(2);
            metricArea.style.color = "";
        }
        metricPerimeter.textContent = perimeter.toFixed(2);

        if (btnSubdivideMode) {
            btnSubdivideMode.disabled = (coordinates.length < 3 || selfIntersect);
        }

        // Render Coordinate logs list
        coordinatesLogList.innerHTML = '';
        coordinates.forEach((c, idx) => {
            const item = document.createElement('div');
            item.className = 'text-muted';
            item.innerHTML = `<span class="text-gold">#${idx+1}:</span> Lat: ${c.lat.toFixed(6)}, Lng: ${c.lng.toFixed(6)}`;
            coordinatesLogList.appendChild(item);
        });

        // Toggle registry submission
        checkSubmissionsStatus();
        checkBoundaryEncroachment();
    }

    // --- 3. Encroachment Checker Math ---
    function checkBoundaryEncroachment() {
        if (coordinates.length < 3 || neighborLots.length === 0) {
            encroachmentWarning.classList.add('hidden');
            return;
        }

        // Test each edge intersection between active lot and loaded neighbors
        let conflictDetected = false;
        
        for (const neighbor of neighborLots) {
            const polyA = coordinates;
            const polyB = neighbor.coords;

            // Check segment crossings
            for (let i = 0; i < polyA.length; i++) {
                const a1 = polyA[i];
                const a2 = polyA[(i + 1) % polyA.length];

                for (let j = 0; j < polyB.length; j++) {
                    const b1 = polyB[j];
                    const b2 = polyB[(j + 1) % polyB.length];

                    if (checkLineIntersection(a1, a2, b1, b2)) {
                        conflictDetected = true;
                        break;
                    }
                }
                if (conflictDetected) break;
            }

            // Check if any active coordinate is completely inside the neighbor's lot
            if (!conflictDetected) {
                for (const p of polyA) {
                    if (isPointInPolygon(p, polyB)) {
                        conflictDetected = true;
                        break;
                    }
                }
            }
        }

        if (conflictDetected) {
            encroachmentWarning.classList.remove('hidden');
            encroachmentDesc.innerHTML = `<span style="font-weight: 700;">Overlapping Boundary!</span> Your plot crosses into neighbors property lines. Align points or verify fences.`;
        } else {
            encroachmentWarning.classList.add('hidden');
        }
    }

    function checkLineIntersection(a1, a2, b1, b2) {
        // Project to local meters first for accuracy
        const pA1 = projectToMeters(a1.lat, a1.lng);
        const pA2 = projectToMeters(a2.lat, a2.lng);
        const pB1 = projectToMeters(b1.lat, b1.lng);
        const pB2 = projectToMeters(b2.lat, b2.lng);

        const det = (pA2.x - pA1.x) * (pB2.y - pB1.y) - (pA2.y - pA1.y) * (pB2.x - pB1.x);
        if (det === 0) return false; // Parallel lines

        const t = ((pB1.x - pA1.x) * (pB2.y - pB1.y) - (pB1.y - pA1.y) * (pB2.x - pB1.x)) / det;
        const u = ((pB1.x - pA1.x) * (pA2.y - pA1.y) - (pB1.y - pA1.y) * (pA2.x - pA1.x)) / det;

        return (t >= 0 && t <= 1 && u >= 0 && u <= 1);
    }

    // Ray-Casting algorithm (Jordan curve theorem check)
    function isPointInPolygon(p, polygon) {
        let inside = false;
        const n = polygon.length;
        
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = polygon[i].lng, yi = polygon[i].lat;
            const xj = polygon[j].lng, yj = polygon[j].lat;
            
            const intersect = ((yi > p.lat) !== (yj > p.lat)) && 
                              (p.lng < (xj - xi) * (p.lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // --- 4. Interactive Canvas Visual Map Drawing ---
    function drawMap() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        // Draw grid coordinate system
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        
        for (let x = 0; x < canvas.width; x += gridSpacing) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvas.height);
            ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += gridSpacing) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        // Draw loaded neighbor properties
        neighborLots.forEach(lot => {
            ctx.beginPath();
            lot.coords.forEach((coord, idx) => {
                const meters = projectToMeters(coord.lat, coord.lng);
                const screenX = centerX + meters.x * (zoomLevel / 100000);
                const screenY = centerY - meters.y * (zoomLevel / 100000);
                
                if (idx === 0) ctx.moveTo(screenX, screenY);
                else ctx.lineTo(screenX, screenY);
            });
            ctx.closePath();
            
            ctx.fillStyle = 'rgba(59, 130, 246, 0.08)'; // Transparent blue
            ctx.fill();
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]); // Dashed neighbor lines
            ctx.stroke();
            ctx.setLineDash([]);
            
            // Draw neighbor parcel tag text
            if (lot.coords.length > 0) {
                const metersFirst = projectToMeters(lot.coords[0].lat, lot.coords[0].lng);
                const screenX = centerX + metersFirst.x * (zoomLevel / 100000);
                const screenY = centerY - metersFirst.y * (zoomLevel / 100000);
                ctx.fillStyle = 'rgba(59, 130, 246, 0.7)';
                ctx.font = '9px monospace';
                ctx.fillText(`Neighbor: ${lot.owner.substring(0,6)}...`, screenX + 5, screenY - 5);
            }
        });

        // Draw active polygon plotted lot
        if (coordinates.length > 0) {
            ctx.beginPath();
            coordinates.forEach((coord, idx) => {
                const meters = projectToMeters(coord.lat, coord.lng);
                const screenX = centerX + meters.x * (zoomLevel / 100000);
                const screenY = centerY - meters.y * (zoomLevel / 100000);
                
                if (idx === 0) ctx.moveTo(screenX, screenY);
                else ctx.lineTo(screenX, screenY);
            });

            if (coordinates.length >= 3) {
                ctx.closePath();
                ctx.fillStyle = rtkFixActive ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.08)';
                ctx.fill();
            }

            ctx.strokeStyle = rtkFixActive ? '#10b981' : '#f59e0b';
            ctx.lineWidth = 3;
            ctx.stroke();

            // Draw coordinate point circles
            coordinates.forEach((coord, idx) => {
                const meters = projectToMeters(coord.lat, coord.lng);
                const screenX = centerX + meters.x * (zoomLevel / 100000);
                const screenY = centerY - meters.y * (zoomLevel / 100000);
                
                ctx.beginPath();
                ctx.arc(screenX, screenY, 6, 0, 2 * Math.PI);
                ctx.fillStyle = rtkFixActive ? '#10b981' : '#f59e0b';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.stroke();

                // Point index number
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 9px Outfit';
                ctx.fillText(idx + 1, screenX - 3, screenY - 8);
            });
        }
    }

    // Capture click coordinate plotting
    canvas.addEventListener('click', (e) => {
        if (nmeaSectorInterval) return; // Prevent manual edits during active rover simulation walk

        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;

        let metersX = (mouseX - centerX) / (zoomLevel / 100000);
        let metersY = (centerY - mouseY) / (zoomLevel / 100000);

        if (snapToGrid) {
            // Simple grid snapping bounds
            metersX = Math.round(metersX / 10) * 10;
            metersY = Math.round(metersY / 10) * 10;
        }

        const latLng = projectToLatLng(metersX, metersY);
        coordinates.push(latLng);

        updateCalculations();
        drawMap();
    });

    btnToggleGrid.addEventListener('click', () => {
        snapToGrid = !snapToGrid;
        btnToggleGrid.classList.toggle('active', snapToGrid);
        btnToggleGrid.style.borderColor = snapToGrid ? 'var(--cheese-gold)' : 'var(--border-glass)';
    });

    btnClearPlot.addEventListener('click', () => {
        coordinates = [];
        updateCalculations();
        drawMap();
        stopRoverWalk();
    });

    // --- 5. Simulated GNSS Rover & Web-NTRIP Correction Stream ---
    let isRoverConnected = false;
    let isNtripConnected = false;

    btnConnectRover.addEventListener('click', () => {
        isRoverConnected = !isRoverConnected;
        if (isRoverConnected) {
            btnConnectRover.innerHTML = `<i class="fa-solid fa-bluetooth"></i> Disconnect Rover`;
            btnConnectRover.style.borderColor = 'var(--green-accent)';
            roverLinkStatus.textContent = "Connected (BT)";
            roverLinkStatus.className = "status-pill connected";
            
            // Standard GPS status fallback prior to corrections
            rtkPrecisionStatus.textContent = "3D Autonomous Fix";
            rtkPrecisionStatus.className = "status-pill connected";
            roverSatsCount.textContent = "12 / 32";
            roverRmsError.textContent = "3.20 m";
            roverRmsError.style.color = "var(--red-alert)";
        } else {
            btnConnectRover.innerHTML = `<i class="fa-solid fa-bluetooth"></i> Connect External Rover`;
            btnConnectRover.style.borderColor = 'var(--cheese-gold)';
            roverLinkStatus.textContent = "Disconnected";
            roverLinkStatus.className = "status-pill disconnected";
            
            rtkPrecisionStatus.textContent = "No GNSS Data";
            rtkPrecisionStatus.className = "status-pill disconnected";
            roverSatsCount.textContent = "0 / 32";
            roverRmsError.textContent = "0.00 m";
            roverRmsError.style.color = "var(--red-alert)";
            
            rtkFixActive = false;
            stopRoverWalk();
        }
        drawMap();
    });

    btnConnectNtrip.addEventListener('click', () => {
        if (!isRoverConnected) {
            alert("NTRIP corrections require an active Bluetooth GNSS Rover connection. Connect Bluetooth Rover first.");
            return;
        }

        isNtripConnected = !isNtripConnected;
        if (isNtripConnected) {
            btnConnectNtrip.innerHTML = `<i class="fa-solid fa-plug-circle-check"></i> Disconnect Stream`;
            btnConnectNtrip.style.borderColor = 'var(--green-accent)';
            
            console.log(`Connecting Web-NTRIP client caster to: ${ntripCaster.value}`);
            console.log(`Requesting RTCM correction mountpoint: ${ntripMountpoint.value}`);

            // Show active DePIN rewards box if connected to community node
            if (ntripCasterSelect && ntripCasterSelect.value !== 'government') {
                depinNodeRewards.classList.remove('hidden');
            }

            // Transition precision from Autonomous -> DGPS -> RTK FLOAT -> RTK FIX
            setTimeout(() => {
                if (!isNtripConnected) return;
                rtkPrecisionStatus.textContent = "RTK Float (DGPS)";
                rtkPrecisionStatus.className = "status-pill rtk-float";
                roverSatsCount.textContent = "18 / 32";
                roverRmsError.textContent = "0.45 m";
                roverRmsError.style.color = "var(--cheese-gold)";
                
                setTimeout(() => {
                    if (!isNtripConnected) return;
                    rtkPrecisionStatus.textContent = "RTK FIX (Centimeter)";
                    rtkPrecisionStatus.className = "status-pill connected";
                    roverSatsCount.textContent = "24 / 32";
                    roverRmsError.textContent = "0.015 m (1.5 cm)";
                    roverRmsError.style.color = "var(--green-accent)";
                    rtkFixActive = true;
                    drawMap();
                    alert("RTK Lock established! Positioning accuracy calibrated to 1.5 cm.");
                }, 2000);
            }, 1500);

        } else {
            btnConnectNtrip.innerHTML = `<i class="fa-solid fa-plug"></i> Stream NAMRIA Corrections`;
            btnConnectNtrip.style.borderColor = 'var(--border-glass)';
            
            rtkPrecisionStatus.textContent = "3D Autonomous Fix";
            rtkPrecisionStatus.className = "status-pill connected";
            roverSatsCount.textContent = "12 / 32";
            roverRmsError.textContent = "3.20 m";
            roverRmsError.style.color = "var(--red-alert)";
            
            rtkFixActive = false;
            if (depinNodeRewards) depinNodeRewards.classList.add('hidden');
            drawMap();
        }
    });

    // Walk simulated surveyor RTK rover boundary points
    btnSimulateRoverTrack.addEventListener('click', () => {
        if (!isRoverConnected || !rtkFixActive) {
            alert("Boundary walking requires an active RTK GNSS Lock to ensure 1-2 cm geodetic accuracy. Setup Bluetooth Rover and NTRIP streams first.");
            return;
        }

        if (nmeaSectorInterval) {
            stopRoverWalk();
            return;
        }

        coordinates = [];
        btnSimulateRoverTrack.innerHTML = `<i class="fa-solid fa-square-person-confining"></i> Recording Path...`;
        btnSimulateRoverTrack.style.backgroundColor = 'var(--green-accent)';
        
        // Define paths around Manila grid coordinates
        const pathPoints = [
            { x: -50, y: -50 },
            { x: -50, y: 50 },
            { x: 50, y: 50 },
            { x: 50, y: -50 }
        ];
        
        let i = 0;
        console.log("Starting geodetic NMEA survey stream logging...");

        nmeaSectorInterval = setInterval(() => {
            if (i >= pathPoints.length) {
                stopRoverWalk();
                return;
            }
            
            const p = pathPoints[i];
            const coord = projectToLatLng(p.x, p.y);
            
            // Format coordinates into NMEA standard minutes format (DDMM.MMMM / DDDMM.MMMM)
            const decLat = coord.lat;
            const decLon = coord.lng;

            const latDeg = Math.floor(Math.abs(decLat));
            const latMin = (Math.abs(decLat) - latDeg) * 60;
            const latStr = `${latDeg.toString().padStart(2,'0')}${latMin.toFixed(4)}`;
            const latDir = decLat >= 0 ? 'N' : 'S';

            const lonDeg = Math.floor(Math.abs(decLon));
            const lonMin = (Math.abs(decLon) - lonDeg) * 60;
            const lonStr = `${lonDeg.toString().padStart(3,'0')}${lonMin.toFixed(4)}`;
            const lonDir = decLon >= 0 ? 'E' : 'W';

            const timestampNMEA = new Date().toISOString().split('T')[1].replace(/[:Z]/g, '').substring(0, 9);
            const nmeaSentence = `$GNGGA,${timestampNMEA},${latStr},${latDir},${lonStr},${lonDir},4,24,0.85,12.4,M,0.0,M,3.2,0210*4A`;
            
            console.log(`📡 [NMEA ROVER OUTPUT]: ${nmeaSentence}`);

            // Decode GNGGA sentence using our parser
            const decoded = parseGNGGA(nmeaSentence);
            if (decoded && decoded.fixQuality === 4) {
                coordinates.push({ lat: decoded.lat, lng: decoded.lng });
                updateCalculations();
                drawMap();
            }
            i++;
        }, 1200);
    });

    function stopRoverWalk() {
        if (nmeaSectorInterval) {
            clearInterval(nmeaSectorInterval);
            nmeaSectorInterval = null;
            btnSimulateRoverTrack.innerHTML = `<i class="fa-solid fa-person-walking"></i> Walk Boundary (RTK Rover)`;
            btnSimulateRoverTrack.style.backgroundColor = 'var(--cheese-gold)';
            console.log("Survey path logging completed.");
        }
    }

    btnMockOverlap.addEventListener('click', () => {
        // Load mock neighbor lot details overlapping marginally
        const mockNeigh = {
            owner: '0x712A1cbA607C60D95F27088c80Abbbd1f53d33Fe',
            coords: [
                projectToLatLng(-80, -20),
                projectToLatLng(-80, 80),
                projectToLatLng(-20, 80),
                projectToLatLng(-20, -20)
            ]
        };
        
        neighborLots = [mockNeigh];
        drawMap();
        checkBoundaryEncroachment();
        alert("Mock neighbor lot loaded. Try plotting inside coordinates boundary [-80, -20] to [-20, 80] to test the visual encroachment checker.");
    });

    // --- 6. Ethers.js Wallet & SMS Identity Connectors ---
    btnConnectWallet.addEventListener('click', async () => {
        if (typeof window.ethereum !== 'undefined') {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                walletAddress = accounts[0];
                walletAddressDisplay.textContent = walletAddress.substring(0, 8) + '...' + walletAddress.substring(38);
                btnConnectWallet.innerHTML = `<i class="fa-solid fa-arrow-right-from-bracket"></i> Disconnect`;
                btnConnectWallet.style.backgroundColor = 'var(--red-alert)';
                
                checkSubmissionsStatus();
            } catch (e) {
                alert("Wallet connection rejected.");
            }
        } else {
            alert("MetaMask extension not detected. Use the SMS Signing Bridge below for easy mobile consensus.");
        }
    });

    btnRequestSms.addEventListener('click', () => {
        const phone = phoneInput.value.trim();
        if (!phone) {
            alert("Please input your mobile phone number first.");
            return;
        }
        
        btnRequestSms.innerHTML = `<i class="fa-solid fa-spinner animate-pulse"></i> Sent`;
        smsOtpContainer.classList.remove('hidden');
        console.log(`[SMS-BRIDGE-OTP] Sending one-time signing credential request to mobile: ${phone}`);
        alert("Simulated One-Time SMS Code Sent! Enter '123456' to confirm identity credentials.");
    });

    btnVerifyOtp.addEventListener('click', () => {
        if (otpInput.value.trim() === "123456") {
            // Generate verified Sandbox address mapped to phone
            walletAddress = "0x89C3C17D773acba67ECaE0b47E654648aB0c2eb8";
            walletAddressDisplay.textContent = `${walletAddress.substring(0,8)}... (SMS)`;
            smsOtpContainer.classList.add('hidden');
            btnRequestSms.innerHTML = `<i class="fa-solid fa-check"></i> Verified`;
            btnRequestSms.disabled = true;
            phoneInput.disabled = true;
            
            checkSubmissionsStatus();
            alert("Sovereign mobile credentials verified! Sandbox identity keys active.");
        } else {
            alert("Invalid OTP code.");
        }
    });

    // --- 7. Mutual Consensus Signature Triggers ---
    neighborWalletsInput.addEventListener('input', () => {
        const wallets = neighborWalletsInput.value.split('\n')
            .map(w => w.trim())
            .filter(w => w.startsWith('0x') && w.length === 42);
        
        neighborSignaturesList.innerHTML = '';
        neighborSignatures = {};

        if (wallets.length === 0) {
            neighborSignaturesList.innerHTML = `<span class="text-muted" style="font-size: 0.75rem; text-align: center;">Add neighbors above to configure consensus signoff slots.</span>`;
            checkSubmissionsStatus();
            return;
        }

        wallets.forEach((wallet, index) => {
            neighborSignatures[wallet] = false;
            
            const item = document.createElement('div');
            item.className = 'consensus-item';
            item.id = `neighbor-item-${index}`;
            item.innerHTML = `
                <div>
                    <span class="role-lbl">Neighbor #${index+1}</span>
                    <div style="font-size: 0.65rem; color: var(--text-muted); font-family: monospace;">${wallet.substring(0,8)}...${wallet.substring(38)}</div>
                </div>
                <button class="btn-primary sign-btn" id="btn-sign-neighbor-${index}" style="background: var(--blue-accent); color: #fff;"><i class="fa-solid fa-key"></i> Sign</button>
            `;
            neighborSignaturesList.appendChild(item);

            // Bind individual click simulation
            document.getElementById(`btn-sign-neighbor-${index}`).addEventListener('click', (e) => {
                neighborSignatures[wallet] = true;
                e.target.disabled = true;
                e.target.innerHTML = `<i class="fa-solid fa-check"></i> Signed`;
                e.target.style.background = 'rgba(16, 185, 129, 0.15)';
                e.target.style.color = 'var(--green-accent)';
                e.target.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                
                checkSubmissionsStatus();
            });
        });
        checkSubmissionsStatus();
    });

    btnLguApprove.addEventListener('click', () => {
        isLguApproved = !isLguApproved;
        if (isLguApproved) {
            lguNotaryAddress.textContent = "Barangay Sec. (0x5e878480...) Approved";
            lguNotaryAddress.className = "text-green";
            btnLguApprove.innerHTML = `<i class="fa-solid fa-check"></i> Notarized`;
            btnLguApprove.style.background = 'rgba(16, 185, 129, 0.15)';
            btnLguApprove.style.color = 'var(--green-accent)';
            btnLguApprove.style.borderColor = 'rgba(16, 185, 129, 0.3)';
        } else {
            lguNotaryAddress.textContent = "Not Approved";
            lguNotaryAddress.className = "text-muted";
            btnLguApprove.innerHTML = `<i class="fa-solid fa-building-flag"></i> Notarize`;
            btnLguApprove.style.background = '';
            btnLguApprove.style.color = '';
            btnLguApprove.style.borderColor = '';
        }
        checkSubmissionsStatus();
    });

    btnSurveyorVerify.addEventListener('click', () => {
        if (!rtkFixActive) {
            alert("Cadastral certification requires an active RTK Fixed precision lock (1-2 cm) to stamp geodetic coordinate integrity.");
            return;
        }

        isSurveyorVerified = !isSurveyorVerified;
        if (isSurveyorVerified) {
            surveyorNotaryAddress.textContent = "Geodetic Engr. (0x421454...) Certified";
            surveyorNotaryAddress.className = "text-green";
            btnSurveyorVerify.innerHTML = `<i class="fa-solid fa-check"></i> Certified`;
            btnSurveyorVerify.style.background = 'rgba(16, 185, 129, 0.15)';
            btnSurveyorVerify.style.color = 'var(--green-accent)';
            btnSurveyorVerify.style.borderColor = 'rgba(16, 185, 129, 0.3)';
        } else {
            surveyorNotaryAddress.textContent = "Not Verified";
            surveyorNotaryAddress.className = "text-muted";
            btnSurveyorVerify.innerHTML = `<i class="fa-solid fa-clipboard-check"></i> Stamp`;
            btnSurveyorVerify.style.background = '';
            btnSurveyorVerify.style.color = '';
            btnSurveyorVerify.style.borderColor = '';
        }
        checkSubmissionsStatus();
    });

    // Check overall verification metrics
    function checkSubmissionsStatus() {
        const areaVal = parseFloat(metricArea.textContent);
        if (!walletAddress || coordinates.length < 3 || areaVal === 0 || isNaN(areaVal)) {
            btnSubmitRegistry.disabled = true;
            return;
        }

        // Sibling Subdivision check path
        if (subdivisionActive) {
            if (sibling1Signed && sibling2Signed && isSurveyorVerified && isLguApproved) {
                btnSubmitRegistry.disabled = false;
            } else {
                btnSubmitRegistry.disabled = true;
            }
            return;
        }

        // Must have at least 1 neighbor configured and ALL neighbors must have signed
        const neighborCount = Object.keys(neighborSignatures).length;
        if (neighborCount === 0) {
            btnSubmitRegistry.disabled = true;
            return;
        }

        let neighborsSigned = true;
        for (const w in neighborSignatures) {
            if (!neighborSignatures[w]) {
                neighborsSigned = false;
                break;
            }
        }

        // Enable registry submission if neighbors consensus + surveyor verify + lgu approve are signed!
        if (neighborsSigned && isSurveyorVerified && isLguApproved) {
            btnSubmitRegistry.disabled = false;
        } else {
            btnSubmitRegistry.disabled = true;
        }
    }

    // --- 8. Local Ledger Registry Database Storage ---
    function loadLedgerRecords() {
        ledgerDatabase = JSON.parse(localStorage.getItem('cheese_cadastre_ledger') || '[]');
        renderLedgerTable();
    }

    function renderLedgerTable() {
        ledgerHistoryRows.innerHTML = '';
        if (ledgerDatabase.length === 0) {
            ledgerHistoryRows.innerHTML = `<tr><td colspan="8" class="text-muted" style="text-align: center; padding: 2rem;">No cadastral block records verified yet. Start plotting to seal the first lot.</td></tr>`;
            return;
        }

        const filter = ledgerSearchInput.value.trim().toLowerCase();

        ledgerDatabase.forEach((rec) => {
            if (filter && !rec.spatialHash.toLowerCase().includes(filter)) return;

            const row = document.createElement('tr');
            row.innerHTML = `
                <td style="font-weight: 700;">CHZ-LOT-${rec.id.toString().padStart(4, '0')}</td>
                <td style="font-family: monospace; font-size: 0.7rem; color: var(--cheese-gold);">${rec.spatialHash.substring(0,18)}...</td>
                <td>${rec.area} sqm</td>
                <td style="font-family: monospace; font-size: 0.7rem;">${rec.owner.substring(0,8)}...</td>
                <td class="text-green" style="font-weight: 600;"><i class="fa-solid fa-user-group"></i> Aligned (${rec.neighborsCount}/${rec.neighborsCount})</td>
                <td class="text-green" style="font-weight: 600;"><i class="fa-solid fa-stamp"></i> Certified</td>
                <td class="text-green" style="font-weight: 600;"><i class="fa-solid fa-building-flag"></i> Sealed</td>
                <td><span class="status-pill connected" style="font-size: 0.6rem;">${rec.precision}</span></td>
            `;
            ledgerHistoryRows.appendChild(row);
        });
    }

    btnSubmitRegistry.addEventListener('click', async () => {
        if (btnSubmitRegistry.disabled) return;

        // Generate coordinate hash
        const sortedCoords = [...coordinates].sort((a, b) => b.lat - a.lat || a.lng - b.lng); // Northernmost first
        const coordsStr = JSON.stringify(sortedCoords);
        
        // Mock SHA-256 generation using subtle crypto or simple string hex mapping
        const textEncoder = new TextEncoder();
        const dataBytes = textEncoder.encode(coordsStr);
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
        const spatialHash = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const newLotRecord = {
            id: ledgerDatabase.length + 1,
            spatialHash: spatialHash,
            coordsJson: coordsStr,
            area: metricArea.textContent,
            owner: walletAddress,
            neighborsCount: subdivisionActive ? 2 : Object.keys(neighborSignatures).length,
            precision: rtkPrecisionStatus.textContent,
            timestamp: Math.floor(Date.now() / 1000)
        };

        ledgerDatabase.unshift(newLotRecord);
        localStorage.setItem('cheese_cadastre_ledger', JSON.stringify(ledgerDatabase));
        
        if (subdivisionActive) {
            alert(`Parent Lot subdivided successfully on-chain!\nTwin Child Lots generated.\nSpatial Hash: ${spatialHash}\nPrecision: 1.5 cm (RTK FIX Verified)`);
            cancelSubdivision();
        } else {
            alert(`Lot boundary ledger sealed successfully on-chain!\nSpatial Hash: ${spatialHash}\nAccuracy: 1.5 cm (RTK FIX Verified)`);
        }
        
        // Reset plotting state
        coordinates = [];
        neighborLots = [];
        updateCalculations();
        drawMap();
        stopRoverWalk();

        // Reset verification UI
        isSurveyorVerified = false;
        isLguApproved = false;
        neighborSignatures = {};
        
        lguNotaryAddress.textContent = "Not Approved";
        lguNotaryAddress.className = "text-muted";
        btnLguApprove.innerHTML = `<i class="fa-solid fa-building-flag"></i> Notarize`;
        btnLguApprove.style.background = '';
        btnLguApprove.style.color = '';
        btnLguApprove.style.borderColor = '';

        surveyorNotaryAddress.textContent = "Not Verified";
        surveyorNotaryAddress.className = "text-muted";
        btnSurveyorVerify.innerHTML = `<i class="fa-solid fa-clipboard-check"></i> Stamp`;
        btnSurveyorVerify.style.background = '';
        btnSurveyorVerify.style.color = '';
        btnSurveyorVerify.style.borderColor = '';

        neighborWalletsInput.value = '';
        neighborSignaturesList.innerHTML = `<span class="text-muted" style="font-size: 0.75rem; text-align: center;">Add neighbors above to configure consensus signoff slots.</span>`;

        renderLedgerTable();
    });

    // --- AI Title Vectorizer (OCR Simulation) ---
    const titleFileUploader = document.getElementById('title-file-uploader');

    function parseMetesAndBounds(text) {
        const lines = text.split('\n');
        let currentX = 0;
        let currentY = 0;
        const parsedPoints = [projectToLatLng(0, 0)];

        const bearingRegex = /([NS])\s*(\d+)\s*deg\s*(\d+)\s*min\s*([EW]),\s*([\d.]+)\s*m/i;

        lines.forEach(line => {
            const match = line.match(bearingRegex);
            if (match) {
                const ns = match[1].toUpperCase();
                const deg = parseFloat(match[2]);
                const min = parseFloat(match[3]);
                const ew = match[4].toUpperCase();
                const dist = parseFloat(match[5]);

                let angle = deg + (min / 60);
                let azimuth = 0;
                if (ns === 'N' && ew === 'E') azimuth = angle;
                else if (ns === 'S' && ew === 'E') azimuth = 180 - angle;
                else if (ns === 'S' && ew === 'W') azimuth = 180 + angle;
                else if (ns === 'N' && ew === 'W') azimuth = 360 - angle;

                const rad = azimuth * Math.PI / 180;
                currentX += dist * Math.sin(rad);
                currentY += dist * Math.cos(rad);

                parsedPoints.push(projectToLatLng(currentX, currentY));
            }
        });

        if (parsedPoints.length > 2) {
            const first = parsedPoints[0];
            const last = parsedPoints[parsedPoints.length - 1];
            const distStart = Math.sqrt(Math.pow(last.lat - first.lat, 2) + Math.pow(last.lng - first.lng, 2));
            if (distStart < 0.0001) {
                parsedPoints.pop();
            }
        }
        return parsedPoints;
    }

    function simulateTitleOcr() {
        const mockTitleText = `
        SURVEY PLAN OF LOT 102-A
        Point 1 to Point 2: N 45 deg 00 min E, 100.00 m
        Point 2 to Point 3: S 45 deg 00 min E, 100.00 m
        Point 3 to Point 4: S 45 deg 00 min W, 100.00 m
        Point 4 to Point 1: N 45 deg 00 min W, 100.00 m
        `;
        
        console.log("Analyzing survey plan metes and bounds...");
        const parsed = parseMetesAndBounds(mockTitleText);
        if (parsed.length >= 3) {
            coordinates = parsed;
            updateCalculations();
            drawMap();
            alert("AI OCR Title Parser complete!\nExtracted 4 boundary vectors from paper description.\nPlotted Lot Area: 10,000.00 sqm.");
        }
    }

    if (titleFileUploader) {
        titleFileUploader.addEventListener('click', simulateTitleOcr);
        titleFileUploader.addEventListener('dragover', (e) => {
            e.preventDefault();
            titleFileUploader.style.borderColor = 'var(--cheese-gold)';
        });
        titleFileUploader.addEventListener('dragleave', () => {
            titleFileUploader.style.borderColor = 'var(--border-glass)';
        });
        titleFileUploader.addEventListener('drop', (e) => {
            e.preventDefault();
            titleFileUploader.style.borderColor = 'var(--border-glass)';
            simulateTitleOcr();
        });
    }

    // --- DePIN Peer Caster Network Selector ---
    const ntripCasterSelect = document.getElementById('ntrip-caster-select');
    const depinNodeRewards = document.getElementById('depin-node-rewards');

    if (ntripCasterSelect) {
        ntripCasterSelect.addEventListener('change', () => {
            const val = ntripCasterSelect.value;
            if (val === 'government') {
                ntripCaster.value = "agn.namria.gov.ph:2101";
                if (depinNodeRewards) depinNodeRewards.classList.add('hidden');
            } else if (val === 'depin-manila') {
                ntripCaster.value = "p2p-manila.cheeseplot.net:5001";
                if (isNtripConnected && depinNodeRewards) depinNodeRewards.classList.remove('hidden');
            } else if (val === 'depin-cebu') {
                ntripCaster.value = "p2p-cebu.cheeseplot.net:5002";
                if (isNtripConnected && depinNodeRewards) depinNodeRewards.classList.remove('hidden');
            } else if (val === 'depin-davao') {
                ntripCaster.value = "p2p-davao.cheeseplot.net:5003";
                if (isNtripConnected && depinNodeRewards) depinNodeRewards.classList.remove('hidden');
            }
        });
    }

    // --- Smart Subdivision (Sibling Split) ---
    const btnSubdivideMode = document.getElementById('btn-subdivide-mode');
    const btnCancelSubdivide = document.getElementById('btn-cancel-subdivide');
    const subdivisionSiblingPanel = document.getElementById('subdivision-sibling-panel');
    
    let originalCoordsBackup = [];
    let subdivisionActive = false;
    let sibling1Signed = false;
    let sibling2Signed = false;

    function triggerSubdivision() {
        if (coordinates.length < 3) return;
        originalCoordsBackup = [...coordinates];
        subdivisionActive = true;

        const n = coordinates.length;
        const m1_idx = 0;
        const m2_idx = Math.floor(n / 2);

        const p1_start = coordinates[m1_idx];
        const p1_end = coordinates[(m1_idx + 1) % n];
        const p2_start = coordinates[m2_idx];
        const p2_end = coordinates[(m2_idx + 1) % n];

        const mid1 = {
            lat: (p1_start.lat + p1_end.lat) / 2,
            lng: (p1_start.lng + p1_end.lng) / 2
        };
        const mid2 = {
            lat: (p2_start.lat + p2_end.lat) / 2,
            lng: (p2_start.lng + p2_end.lng) / 2
        };

        // Sibling Lot 1 vertices
        const child1 = [
            p1_start,
            mid1,
            mid2,
            p2_start
        ];

        coordinates = child1;
        updateCalculations();
        drawMap();

        if (btnSubdivideMode) btnSubdivideMode.classList.add('hidden');
        if (btnCancelSubdivide) btnCancelSubdivide.classList.remove('hidden');
        if (subdivisionSiblingPanel) subdivisionSiblingPanel.classList.remove('hidden');
        
        alert("Subdivision activated!\nLot polygon bisected down the middle into Sibling Lots.\nSibling Lot 1: 5,000.00 sqm.\nSibling Lot 2: 5,000.00 sqm.");
    }

    function cancelSubdivision() {
        if (!subdivisionActive) return;
        coordinates = [...originalCoordsBackup];
        subdivisionActive = false;

        updateCalculations();
        drawMap();

        if (btnSubdivideMode) btnSubdivideMode.classList.remove('hidden');
        if (btnCancelSubdivide) btnCancelSubdivide.classList.add('hidden');
        if (subdivisionSiblingPanel) subdivisionSiblingPanel.classList.add('hidden');

        sibling1Signed = false;
        sibling2Signed = false;
        const btnS1 = document.getElementById('btn-sign-sibling-1');
        const btnS2 = document.getElementById('btn-sign-sibling-2');
        if (btnS1) { btnS1.innerHTML = "Sign"; btnS1.disabled = false; }
        if (btnS2) { btnS2.innerHTML = "Sign"; btnS2.disabled = false; }
    }

    if (btnSubdivideMode) btnSubdivideMode.addEventListener('click', triggerSubdivision);
    if (btnCancelSubdivide) btnCancelSubdivide.addEventListener('click', cancelSubdivision);

    const btnSignSibling1 = document.getElementById('btn-sign-sibling-1');
    const btnSignSibling2 = document.getElementById('btn-sign-sibling-2');

    if (btnSignSibling1) {
        btnSignSibling1.addEventListener('click', (e) => {
            sibling1Signed = true;
            e.target.disabled = true;
            e.target.innerHTML = `<i class="fa-solid fa-check"></i> Signed`;
            checkSubmissionsStatus();
        });
    }

    if (btnSignSibling2) {
        btnSignSibling2.addEventListener('click', (e) => {
            sibling2Signed = true;
            e.target.disabled = true;
            e.target.innerHTML = `<i class="fa-solid fa-check"></i> Signed`;
            checkSubmissionsStatus();
        });
    }

    ledgerSearchInput.addEventListener('input', renderLedgerTable);

    // Initial load
    loadLedgerRecords();
    drawMap();
});
