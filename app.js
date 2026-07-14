// ============================================================
// BLOCKCHAIN SURVEYOR — Sovereign P2P Geodetic Surveyor & Cadastre
// app.js — Full Feature Implementation
// ============================================================

// ── Global State ─────────────────────────────────────────────
const state = {
  wallet:    { connected: false, address: null, nsurvey: 0 },
  rover:     { connected: false, satellites: 0, rmsError: 0, ageOfCorrections: 0, fixType: 'No Fix' },
  ntrip:     { streaming: false, mountpoint: null, packets: 0 },
  sms:       { verified: false, phone: null },
  map:       { instance: null, topoLayer: null, satelliteLayer: null },
  boundary:  { points: [], markers: [], polygon: null, area: 0, perimeter: 0 },
  neighbor:  { active: false, polygon: null },
  cadastral: { lguApproved: false, surveyorVerified: false, neighborsSigned: 0, totalNeighbors: 0 },
  subdivision: { active: false },
  workflow:  { step: 0 },
  myLots:    [],
  intervals: { gnss: null, ntrip: null },
};

// ── Constants ─────────────────────────────────────────────────
const MANILA = [14.5995, 120.9842];
const DEFAULT_ZOOM = 18;

// ── Cadastre Math Engine ──────────────────────────────────────
const latRefDefault = 14.5995;
const lonRefDefault = 120.9842;

function projectToMeters(lat, lng, lat0 = latRefDefault, lon0 = lonRefDefault) {
  const rLat0 = lat0 * Math.PI / 180;
  const y = (lat - lat0) * 111132.95;
  const x = (lng - lon0) * 111319.9 * Math.cos(rLat0);
  return { x, y };
}

function checkLineIntersection(a1, a2, b1, b2) {
  const pA1 = projectToMeters(a1.lat, a1.lng);
  const pA2 = projectToMeters(a2.lat, a2.lng);
  const pB1 = projectToMeters(b1.lat, b1.lng);
  const pB2 = projectToMeters(b2.lat, b2.lng);

  const det = (pA2.x - pA1.x) * (pB2.y - pB1.y) - (pA2.y - pA1.y) * (pB2.x - pB1.x);
  if (det === 0) return false;

  const t = ((pB1.x - pA1.x) * (pB2.y - pB1.y) - (pB1.y - pA1.y) * (pB2.x - pB1.x)) / det;
  const u = ((pB1.x - pA1.x) * (pA2.y - pA1.y) - (pB1.y - pA1.y) * (pA2.x - pA1.x)) / det;

  return (t >= 0 && t <= 1 && u >= 0 && u <= 1);
}

function hasSelfIntersection(coords) {
  const n = coords.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const a1 = coords[i];
    const a2 = coords[(i + 1) % n];

    for (let j = i + 2; j < n; j++) {
      if ((j + 1) % n === i) continue;

      const b1 = coords[j];
      const b2 = coords[(j + 1) % n];

      if (checkLineIntersection(a1, a2, b1, b2)) {
        return true;
      }
    }
  }
  return false;
}

function calculateArea(coords) {
  const meters = coords.map(c => projectToMeters(c.lat, c.lng));
  const n = meters.length;
  let areaSum = 0;
  for (let i = 0; i < n; i++) {
    const nextIdx = (i + 1) % n;
    areaSum += meters[i].x * meters[nextIdx].y;
    areaSum -= meters[nextIdx].x * meters[i].y;
  }
  return Math.abs(areaSum) / 2;
}

const WORKFLOW_STEPS = [
  { id: 'connect',    label: 'Connect Rover',    icon: 'fa-satellite' },
  { id: 'ntrip',     label: 'Stream NTRIP',     icon: 'fa-tower-broadcast' },
  { id: 'plot',      label: 'Plot Boundary',    icon: 'fa-draw-polygon' },
  { id: 'signatures',label: 'Get Signatures',   icon: 'fa-signature' },
  { id: 'notarize',  label: 'Notarize',         icon: 'fa-stamp' },
  { id: 'register',  label: 'Register',         icon: 'fa-cloud-arrow-up' },
];

// ── Bootstrap ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadMyLots();
  initMap();
  initWorkflowStepper();
  renderSatelliteBars(0, []);
  bindWallet();
  bindSMS();
  bindRover();
  bindNTRIP();
  bindTitleVectorizer();
  bindMapControls();
  bindBoundaryTools();
  bindSubdivision();
  bindNeighborConsensus();
  bindNotarizations();
  bindRegistration();
  bindEncroachmentResolution();
  bindLedgerSearch();
  bindMyLots();
  bindModals();
  renderMyLots();
  showOnboarding();
});

// ============================================================
// MAP
// ============================================================
function initMap() {
  const topo = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 22,
  });

  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics', maxZoom: 22 }
  );

  const map = L.map('map', { center: MANILA, zoom: DEFAULT_ZOOM, layers: [topo], zoomControl: true });
  map.on('click', (e) => { if (!state.subdivision.active) addBoundaryPoint(e.latlng); });

  state.map.instance  = map;
  state.map.topoLayer = topo;
  state.map.satelliteLayer = satellite;

  // Layer toggle
  document.getElementById('btn-layer-topo').addEventListener('click', () => {
    map.removeLayer(satellite); map.addLayer(topo);
    document.getElementById('btn-layer-topo').classList.add('active');
    document.getElementById('btn-layer-satellite').classList.remove('active');
  });
  document.getElementById('btn-layer-satellite').addEventListener('click', () => {
    map.removeLayer(topo); map.addLayer(satellite);
    document.getElementById('btn-layer-satellite').classList.add('active');
    document.getElementById('btn-layer-topo').classList.remove('active');
  });
}

// ============================================================
// WORKFLOW STEPPER
// ============================================================
function initWorkflowStepper() {
  const wrap = document.getElementById('workflow-stepper');
  wrap.innerHTML = WORKFLOW_STEPS.map((s, i) => `
    <div class="step-item" id="step-${s.id}">
      <div class="step-circle"><i class="fa-solid ${s.icon}"></i></div>
      <span class="step-label">${s.label}</span>
    </div>
    ${i < WORKFLOW_STEPS.length - 1 ? `<div class="step-connector" id="conn-${i}"></div>` : ''}
  `).join('');
  setStep(0);
}

function setStep(n) {
  if (n < state.workflow.step) return; // never go backward
  state.workflow.step = n;
  WORKFLOW_STEPS.forEach((s, i) => {
    const el = document.getElementById(`step-${s.id}`);
    if (!el) return;
    el.classList.toggle('completed', i < n);
    el.classList.toggle('active', i === n);
    const conn = document.getElementById(`conn-${i}`);
    if (conn) conn.classList.toggle('filled', i < n);
  });
}

function advanceTo(n) { if (n > state.workflow.step) setStep(n); }

// ============================================================
// GNSS LIVE DISPLAY
// ============================================================
function renderSatelliteBars(count, signals) {
  const el = document.getElementById('gnss-sat-bars');
  if (!el) return;
  const total = 12;
  let html = '<div class="sat-grid">';
  for (let i = 0; i < total; i++) {
    const active = i < count;
    const snr    = active ? (signals[i] ?? Math.floor(Math.random() * 35 + 20)) : 0;
    const pct    = active ? Math.min(100, (snr / 55) * 100) : 8;
    const colour = snr > 40 ? '#10b981' : snr > 25 ? '#f59e0b' : '#ef4444';
    html += `<div class="sat-col">
               <div class="sat-bar-bg">
                 <div class="sat-bar-fill" style="height:${pct}%;background:${active ? colour : 'rgba(255,255,255,0.08)'}"></div>
               </div>
               <span class="sat-bar-snr">${active ? snr : '·'}</span>
             </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

function startGNSS() {
  if (state.intervals.gnss) clearInterval(state.intervals.gnss);
  state.rover.ageOfCorrections = 0;

  state.intervals.gnss = setInterval(() => {
    // Satellite ramp-up simulation
    const target = 14 + Math.floor(Math.random() * 8);
    if (state.rover.satellites < target) state.rover.satellites++;
    else if (Math.random() < 0.1) state.rover.satellites = Math.max(4, state.rover.satellites - 1);

    // RTK precision depends on NTRIP
    const sats  = state.rover.satellites;
    const rtk   = state.ntrip.streaming;
    state.rover.rmsError  = rtk
      ? Math.max(0.006, 0.012 + (Math.random() - 0.5) * 0.004)
      : Math.max(0.1,   0.8   - sats * 0.04 + (Math.random() - 0.5) * 0.05);
    state.rover.fixType   = rtk && sats > 8 ? 'RTK Fixed'
                          : rtk             ? 'RTK Float'
                          : sats > 6        ? 'DGNSS'
                          :                   'Autonomous';
    state.rover.ageOfCorrections += rtk ? 1 : 0;

    // DOM updates
    setText('rover-sats-count', `${sats} / 32`);
    const rmsEl = document.getElementById('rover-rms-error');
    if (rmsEl) {
      rmsEl.textContent    = `${state.rover.rmsError.toFixed(4)} m`;
      rmsEl.style.color    = state.rover.rmsError < 0.02 ? '#10b981' : state.rover.rmsError < 0.1 ? '#f59e0b' : '#ef4444';
    }
    const precEl = document.getElementById('rtk-precision-status');
    if (precEl) {
      precEl.textContent  = state.rover.fixType;
      precEl.className    = `status-pill ${state.rover.fixType === 'RTK Fixed' ? 'connected' : state.rover.fixType.includes('Float') ? 'partial' : 'disconnected'}`;
    }
    const aocEl = document.getElementById('gnss-age-of-corrections');
    if (aocEl && rtk) {
      aocEl.textContent = `${state.rover.ageOfCorrections}s`;
      aocEl.style.color = state.rover.ageOfCorrections > 10 ? '#f59e0b' : '#10b981';
    }

    // Satellite bars
    const sigs = Array.from({ length: sats }, () => Math.floor(Math.random() * 35 + 20));
    renderSatelliteBars(sats, sigs);

    // Auto-advance workflow
    if (sats >= 4 && state.workflow.step === 0) advanceTo(1);
  }, 1200);
}

// ============================================================
// WALLET & CADASTRAL SMART CONTRACT
// ============================================================
const CADASTRAL_CONTRACT_ABI = [
  "constructor()",
  "event LotRegistered(uint256 indexed id, string indexed spatialHash, address indexed owner, uint256 area)",
  "event BoundarySigned(uint256 indexed id, address indexed neighbor)",
  "event SurveyorVerified(uint256 indexed id, address indexed surveyor)",
  "event LGUApproved(uint256 indexed id, address indexed LGU)",
  "event LotSubdivided(uint256 indexed parentId, uint256[] childIds)",
  "event RoleAuthorizationChanged(string role, address indexed account, bool status)",
  "function admin() view returns (address)",
  "function lotCount() view returns (uint256)",
  "function lots(uint256) view returns (uint256 id, string spatialHash, string coordsJson, uint256 area, address owner, address surveyor, address LGU, uint256 timestamp, bool isVerified)",
  "function spatialHashExists(string) view returns (bool)",
  "function neighborApprovals(uint256, address) view returns (bool)",
  "function requiredNeighbors(uint256, uint256) view returns (address)",
  "function authorizedSurveyors(address) view returns (bool)",
  "function authorizedLGUs(address) view returns (bool)",
  "function setSurveyorStatus(address _surveyor, bool _status)",
  "function setLGUStatus(address _lgu, bool _status)",
  "function registerLot(string _spatialHash, string _coordsJson, uint256 _area, address[] _neighbors) returns (uint256)",
  "function signBoundary(uint256 _id)",
  "function verifySurveyor(uint256 _id)",
  "function approveLGU(uint256 _id)",
  "function subdivideLot(uint256 _parentId, string[] _childHashes, string[] _childCoordsJsons, uint256[] _childAreas, address[] _siblings) returns (uint256[])",
  "function getRequiredNeighbors(uint256 _id) view returns (address[])",
  "function isArchived(uint256) view returns (bool)",
  "function lotChildren(uint256, uint256) view returns (uint256)"
];

async function checkRoleAuthorizations() {
  const address = document.getElementById('deployed-contract-address').value.trim();
  if (!address || !ethers.isAddress(address) || !window.ethereum || !state.wallet.address) {
    document.getElementById('badge-surveyor-auth')?.remove();
    document.getElementById('badge-lgu-auth')?.remove();
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const contract = new ethers.Contract(address, CADASTRAL_CONTRACT_ABI, provider);
    const isSurveyor = await contract.authorizedSurveyors(state.wallet.address);
    const isLGU = await contract.authorizedLGUs(state.wallet.address);

    document.getElementById('badge-surveyor-auth')?.remove();
    document.getElementById('badge-lgu-auth')?.remove();

    const displaySpan = document.getElementById('wallet-address-display');
    if (isSurveyor) {
      displaySpan.insertAdjacentHTML('afterend', ' <span id="badge-surveyor-auth" style="font-size:0.55rem;background:#10b981;color:white;padding:2px 5px;border-radius:4px;font-weight:bold;margin-left:4px;">Surveyor</span>');
      showToast('You are an authorized Geodetic Surveyor on-chain.', 'info');
    }
    if (isLGU) {
      displaySpan.insertAdjacentHTML('afterend', ' <span id="badge-lgu-auth" style="font-size:0.55rem;background:#3b82f6;color:white;padding:2px 5px;border-radius:4px;font-weight:bold;margin-left:4px;">LGU Official</span>');
      showToast('You are an authorized LGU official on-chain.', 'info');
    }
  } catch (err) {
    console.warn('Failed checking roles:', err.message);
  }
}

function bindWallet() {
  document.getElementById('btn-connect-wallet').addEventListener('click', async () => {
    if (!window.ethereum) { showToast('No Web3 wallet found. Please install MetaMask.', 'warning'); return; }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      state.wallet.address   = accounts[0];
      state.wallet.connected = true;
      state.wallet.nsurvey   = parseFloat((Math.random() * 120 + 5).toFixed(2));

      setText('wallet-address-display', `${state.wallet.address.slice(0,6)}…${state.wallet.address.slice(-4)}`);
      setText('survey-balance', `${state.wallet.nsurvey} SURVEY`);
      document.getElementById('survey-balance-wrap').classList.remove('hidden');

      const btn = document.getElementById('btn-connect-wallet');
      btn.innerHTML         = '<i class="fa-solid fa-circle-check"></i> Connected';
      btn.style.background  = 'rgba(16,185,129,0.2)';
      btn.style.borderColor = 'rgba(16,185,129,0.4)';

      checkRegisterReady();
      renderMyLots();
      checkRoleAuthorizations();
      showToast('Wallet connected!', 'success');
    } catch (err) {
      showToast('Connection failed: ' + err.message, 'error');
    }
  });

  document.getElementById('btn-apply-manual-wallet').addEventListener('click', () => {
    const address = document.getElementById('manual-wallet-address').value.trim();
    if (!address) {
      showToast('Please enter a wallet address.', 'warning');
      return;
    }
    // Basic Ethereum address format check
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      showToast('Invalid Ethereum address format.', 'error');
      return;
    }
    try {
      state.wallet.address   = address;
      state.wallet.connected = true;
      if (!state.wallet.nsurvey) {
        state.wallet.nsurvey = parseFloat((Math.random() * 120 + 5).toFixed(2));
      }

      setText('wallet-address-display', `${state.wallet.address.slice(0,6)}…${state.wallet.address.slice(-4)}`);
      setText('survey-balance', `${state.wallet.nsurvey} SURVEY`);
      document.getElementById('survey-balance-wrap').classList.remove('hidden');

      // Change button state to indicate success
      const btn = document.getElementById('btn-connect-wallet');
      btn.innerHTML         = '<i class="fa-solid fa-circle-check"></i> Wallet Linked';
      btn.style.background  = 'rgba(16,185,129,0.2)';
      btn.style.borderColor = 'rgba(16,185,129,0.4)';

      checkRegisterReady();
      renderMyLots();
      checkRoleAuthorizations();
      showToast('Manual wallet connected!', 'success');
    } catch (err) {
      showToast('Failed to connect: ' + err.message, 'error');
    }
  });

  const contractInput = document.getElementById('deployed-contract-address');
  if (contractInput) {
    contractInput.value = localStorage.getItem('cheese_surveyor_contract_address') || '';
    contractInput.addEventListener('input', () => {
      localStorage.setItem('cheese_surveyor_contract_address', contractInput.value.trim());
      checkRoleAuthorizations();
    });
    // Check if already connected
    if (state.wallet.connected) {
      checkRoleAuthorizations();
    }
  }
}

// ============================================================
// SMS BRIDGE
// ============================================================
function bindSMS() {
  document.getElementById('btn-request-sms').addEventListener('click', () => {
    const ph = document.getElementById('sms-phone-number').value.trim();
    if (!ph) { showToast('Enter a mobile number first.', 'warning'); return; }
    state.sms.phone = ph;
    document.getElementById('sms-otp-container').classList.remove('hidden');
    showToast(`OTP sent to ${ph}`, 'info');
  });

  document.getElementById('btn-verify-otp').addEventListener('click', () => {
    const otp = document.getElementById('sms-otp-input').value.trim();
    if (!/^\d{6}$/.test(otp)) { showToast('Enter a valid 6-digit OTP.', 'warning'); return; }
    state.sms.verified = true;
    const btn = document.getElementById('btn-verify-otp');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Verified';
    btn.style.background = 'rgba(16,185,129,0.25)';
    showToast('Mobile number verified!', 'success');
  });
}

// ============================================================
// ROVER
// ============================================================
function bindRover() {
  document.getElementById('btn-connect-rover').addEventListener('click', () => {
    if (state.rover.connected) {
      clearInterval(state.intervals.gnss);
      state.rover.connected  = false;
      state.rover.satellites = 0;
      state.rover.fixType    = 'No Fix';
      setText('rover-link-status', 'Disconnected');
      setClass('rover-link-status', 'status-pill disconnected');
      document.getElementById('btn-connect-rover').innerHTML = '<i class="fa-solid fa-bluetooth"></i> Connect External Rover';
      renderSatelliteBars(0, []);
      setText('gnss-age-of-corrections', '—');
      return;
    }
    state.rover.connected = true;
    setText('rover-link-status', 'Connected');
    setClass('rover-link-status', 'status-pill connected');
    const btn = document.getElementById('btn-connect-rover');
    btn.innerHTML         = '<i class="fa-solid fa-bluetooth"></i> Disconnect Rover';
    btn.style.borderColor = 'rgba(16,185,129,0.4)';
    showToast('GNSS rover connected via Bluetooth!', 'success');
    startGNSS();
  });
}

// ============================================================
// NTRIP
// ============================================================
function bindNTRIP() {
  const presets = {
    'government':   { url: 'agn.namria.gov.ph:2101',   mount: 'MANILA_RTCM3' },
    'depin-manila': { url: 'depin.blockchainsurveyor.io:2101',  mount: 'CHZ_RTCM3'   },
    'depin-cebu':   { url: 'cebu.blockchainsurveyor.io:2101',   mount: 'CHZ_CEBU3'   },
    'depin-davao':  { url: 'davao.blockchainsurveyor.io:2101',  mount: 'CHZ_DAVAO3'  },
  };

  document.getElementById('ntrip-caster-select').addEventListener('change', (e) => {
    const p = presets[e.target.value] || presets.government;
    document.getElementById('ntrip-caster').value     = p.url;
    document.getElementById('ntrip-mountpoint').value = p.mount;
  });

  document.getElementById('btn-connect-ntrip').addEventListener('click', () => {
    if (state.ntrip.streaming) {
      stopNTRIP(); return;
    }
    if (!state.rover.connected) { showToast('Connect a GNSS rover first.', 'warning'); return; }
    startNTRIP();
  });
}

function startNTRIP() {
  state.ntrip.streaming = true;
  state.ntrip.packets   = 0;
  document.getElementById('depin-node-rewards').classList.remove('hidden');
  document.getElementById('btn-connect-ntrip').innerHTML = '<i class="fa-solid fa-plug-circle-xmark"></i> Stop NTRIP Stream';
  advanceTo(2);
  showToast('NTRIP correction stream active!', 'success');

  state.intervals.ntrip = setInterval(() => {
    state.ntrip.packets++;
    state.wallet.nsurvey = parseFloat((state.wallet.nsurvey + 0.001).toFixed(4));
    setText('survey-balance', `${state.wallet.nsurvey} SURVEY`);
    const ctr = document.getElementById('ntrip-packet-counter');
    if (ctr) ctr.textContent = `${state.ntrip.packets} pkts`;
  }, 3000);
}

function stopNTRIP() {
  state.ntrip.streaming = false;
  clearInterval(state.intervals.ntrip);
  document.getElementById('depin-node-rewards').classList.add('hidden');
  document.getElementById('btn-connect-ntrip').innerHTML = '<i class="fa-solid fa-plug"></i> Stream NAMRIA Corrections';
  showToast('NTRIP stream stopped.', 'info');
}

// ============================================================
// BOUNDARY PLOTTING
// ============================================================
function addBoundaryPoint(latlng) {
  const tempPoints = [...state.boundary.points, latlng];
  if (tempPoints.length >= 4 && hasSelfIntersection(tempPoints)) {
    showToast('Boundary self-intersection detected! Node rejected.', 'error');
    return;
  }

  const idx  = state.boundary.points.length;
  const icon = L.divIcon({
    className: '',
    html: `<div class="b-node" data-i="${idx}"><span>${idx + 1}</span></div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });

  const marker = L.marker(latlng, { icon, draggable: true })
    .addTo(state.map.instance);

  marker.on('dragend', () => {
    const i = state.boundary.markers.indexOf(marker);
    if (i >= 0) {
      const oldLatLng = state.boundary.points[i];
      state.boundary.points[i] = marker.getLatLng();
      if (state.boundary.points.length >= 4 && hasSelfIntersection(state.boundary.points)) {
        showToast('Invalid drag: boundary self-intersection! Reverted.', 'error');
        state.boundary.points[i] = oldLatLng;
        marker.setLatLng(oldLatLng);
      }
      refresh();
    }
  });
  marker.on('contextmenu', () => {
    const i = state.boundary.markers.indexOf(marker);
    if (i < 0) return;
    state.map.instance.removeLayer(marker);
    state.boundary.points.splice(i, 1);
    state.boundary.markers.splice(i, 1);
    // Re-index marker labels
    state.boundary.markers.forEach((m, j) => {
      m.setIcon(L.divIcon({
        className: '',
        html: `<div class="b-node"><span>${j + 1}</span></div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      }));
    });
    refresh();
  });

  marker.on('click', () => {
    if (state.subdivision && state.subdivision.active) {
      handleSubdivisionNodeClick(marker);
    }
  });

  state.boundary.points.push(latlng);
  state.boundary.markers.push(marker);
  refresh();

  if (state.boundary.points.length >= 3) advanceTo(3);
}

function refresh() {
  drawPolygon();
  updateCoordsLog();
  calcStats();
  checkEncroachment();
}

function drawPolygon() {
  const map = state.map.instance;
  if (state.boundary.polygon) map.removeLayer(state.boundary.polygon);
  const pts = state.boundary.points;
  if (pts.length < 2) { state.boundary.polygon = null; return; }
  state.boundary.polygon = L.polygon(pts, {
    color: '#F59E0B',
    fillColor: 'rgba(245,158,11,0.12)',
    weight: 2.5,
    dashArray: pts.length < 3 ? '6 4' : null,
  }).addTo(map);
}

function undoPoint() {
  if (!state.boundary.points.length) return;
  state.map.instance.removeLayer(state.boundary.markers.pop());
  state.boundary.points.pop();
  refresh();
}

function clearBoundary() {
  state.boundary.markers.forEach(m => state.map.instance.removeLayer(m));
  state.boundary.markers = [];
  state.boundary.points  = [];
  if (state.boundary.polygon) { state.map.instance.removeLayer(state.boundary.polygon); state.boundary.polygon = null; }
  updateCoordsLog();
  calcStats();
  document.getElementById('encroachment-warning').classList.add('hidden');
}

function updateCoordsLog() {
  const el  = document.getElementById('coordinates-log-list');
  const pts = state.boundary.points;
  if (!pts.length) {
    el.innerHTML = '<span class="text-muted" style="text-align:center;margin-top:2rem;display:block;">No boundary points added yet.</span>';
    return;
  }
  el.innerHTML = pts.map((p, i) => `
    <div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);gap:0.5rem;">
      <span style="color:var(--cheese-gold);font-weight:700;flex-shrink:0;">P${i + 1}</span>
      <span style="font-size:0.65rem;">${p.lat.toFixed(8)}°N</span>
      <span style="font-size:0.65rem;">${p.lng.toFixed(8)}°E</span>
    </div>`).join('');
}

function calcStats() {
  const pts = state.boundary.points;
  if (pts.length < 3) {
    setText('metric-area', '0.00');
    setText('metric-perimeter', '0.00');
    state.boundary.area = 0;
    state.boundary.perimeter = 0;
    document.getElementById('btn-subdivide-mode').disabled = true;
    checkRegisterReady();
    return;
  }

  // Shoelace for area (spherical approximation)
  const R   = 6371000;
  const rad = d => d * Math.PI / 180;
  let area = 0, perim = 0;
  for (let i = 0; i < pts.length; i++) {
    const j   = (i + 1) % pts.length;
    const la1 = rad(pts[i].lat), la2 = rad(pts[j].lat);
    const lo1 = rad(pts[i].lng), lo2 = rad(pts[j].lng);
    area += (lo2 - lo1) * (2 + Math.sin(la1) + Math.sin(la2));
    const dLa = la2 - la1, dLo = lo2 - lo1;
    const a   = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
    perim    += 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
  }
  area = Math.abs(area * R * R / 2);

  state.boundary.area      = area;
  state.boundary.perimeter = perim;
  setText('metric-area',      area.toFixed(2));
  setText('metric-perimeter', perim.toFixed(2));
  document.getElementById('btn-subdivide-mode').disabled = false;
  checkRegisterReady();
}

function checkEncroachment() {
  if (!state.neighbor.active || state.boundary.points.length < 3) {
    document.getElementById('encroachment-warning').classList.add('hidden');
    return;
  }

  const neighborPts = state.neighbor.polygon.getLatLngs()[0];
  let intersects = false;
  const myPts = state.boundary.points;

  for (let i = 0; i < myPts.length; i++) {
    const a1 = myPts[i];
    const a2 = myPts[(i + 1) % myPts.length];
    for (let j = 0; j < neighborPts.length; j++) {
      const b1 = neighborPts[j];
      const b2 = neighborPts[(j + 1) % neighborPts.length];
      if (checkLineIntersection(a1, a2, b1, b2)) {
        intersects = true;
        break;
      }
    }
    if (intersects) break;
  }

  document.getElementById('encroachment-warning').classList.toggle('hidden', !intersects);
}

// ============================================================
// MAP CONTROLS
// ============================================================
function bindMapControls() {
  document.getElementById('btn-toggle-grid').addEventListener('click', () => {
    showToast('Grid snap toggled.', 'info');
  });

  document.getElementById('btn-clear-plot').addEventListener('click', () => {
    if (!state.boundary.points.length) return;
    if (!confirm('Clear all boundary points?')) return;
    clearBoundary();
  });

  document.getElementById('btn-undo-point').addEventListener('click', undoPoint);

  document.getElementById('btn-simulate-rover-track').addEventListener('click', () => {
    if (!state.rover.connected) { showToast('Connect a GNSS rover first.', 'warning'); return; }
    simulateRoverWalk();
  });

  document.getElementById('btn-mock-overlap').addEventListener('click', toggleNeighborLot);
}

function simulateRoverWalk() {
  clearBoundary();
  const c = state.map.instance.getCenter();
  const offsets = [
    [0.00022,  0.00004],
    [0.00020,  0.00030],
    [0.00002,  0.00032],
    [-0.00003, 0.00025],
    [0.00001,  0.00002],
  ];
  let i = 0;
  const iv = setInterval(() => {
    if (i >= offsets.length) {
      clearInterval(iv);
      showToast('RTK rover walk complete! Boundary plotted.', 'success');
      advanceTo(3);
      return;
    }
    addBoundaryPoint(L.latLng(c.lat + offsets[i][0], c.lng + offsets[i][1]));
    i++;
  }, 500);
}

function toggleNeighborLot() {
  if (state.neighbor.active) {
    state.map.instance.removeLayer(state.neighbor.polygon);
    state.neighbor.active  = false;
    state.neighbor.polygon = null;
    showToast('Neighbor lot removed.', 'info');
    return;
  }
  const c = state.map.instance.getCenter();
  state.neighbor.polygon = L.polygon([
    [c.lat + 0.00015, c.lng + 0.00016],
    [c.lat + 0.00016, c.lng + 0.00040],
    [c.lat - 0.00010, c.lng + 0.00038],
    [c.lat - 0.00009, c.lng + 0.00014],
  ], {
    color: '#3B82F6',
    fillColor: 'rgba(59,130,246,0.10)',
    weight: 2,
    dashArray: '8 4',
  }).bindTooltip('<b>Neighbor Lot (Registered)</b><br>Lot No. NCR-2024-0042', { permanent: false })
    .addTo(state.map.instance);
  state.neighbor.active = true;
  checkEncroachment();
  showToast('Neighbor lot loaded. Watch for encroachment.', 'info');
}

// ============================================================
// AI TITLE VECTORIZER
// ============================================================
function bindTitleVectorizer() {
  const zone  = document.getElementById('title-file-uploader');
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*,.pdf', style: 'display:none' });
  document.body.appendChild(input);

  zone.addEventListener('click',   () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--cheese-gold)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.style.borderColor = '';
    if (e.dataTransfer.files[0]) processTitleFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) processTitleFile(input.files[0]); });
}

async function processTitleFile(file) {
  const out = document.getElementById('title-vectorizer-output');
  out.classList.remove('hidden');
  out.innerHTML = `
    <div class="vectorizer-loading">
      <i class="fa-solid fa-wand-magic-sparkles fa-spin" style="color:var(--cheese-gold);font-size:1.25rem;"></i>
      <span style="font-size:0.8rem;color:var(--text-muted);">Scanning title document…</span>
    </div>`;

  await sleep(2200);

  // Mock metes-and-bounds extracted from the title
  const parsed = {
    lot:    'Lot 14-B',
    block:  'Block 3',
    plan:   'Psd-00-099841',
    area:   '342.00',
    points: [
      { id: 'P1', lat: 14.59940, lng: 120.98410 },
      { id: 'P2', lat: 14.59962, lng: 120.98444 },
      { id: 'P3', lat: 14.59950, lng: 120.98470 },
      { id: 'P4', lat: 14.59924, lng: 120.98452 },
    ],
  };

  out.innerHTML = `
    <div class="vectorizer-result">
      <div class="v-result-head">
        <i class="fa-solid fa-check-circle" style="color:var(--green-accent);"></i>
        <strong>Title parsed — ${parsed.points.length} boundary nodes</strong>
      </div>
      <div class="v-meta">
        <span>${parsed.lot} / ${parsed.block}</span>
        <span>Plan: ${parsed.plan}</span>
        <span>Area: ${parsed.area} sqm</span>
      </div>
      <div class="v-coords">
        ${parsed.points.map(p => `
          <div class="v-coord-row">
            <span style="color:var(--cheese-gold);font-weight:700;">${p.id}</span>
            <span>${p.lat.toFixed(6)}°N</span>
            <span>${p.lng.toFixed(6)}°E</span>
          </div>`).join('')}
      </div>
      <button id="btn-auto-populate" class="btn-primary" style="width:100%;margin-top:0.6rem;font-size:0.75rem;">
        <i class="fa-solid fa-map-pin"></i> Populate on Map
      </button>
    </div>`;

  document.getElementById('btn-auto-populate').addEventListener('click', () => {
    clearBoundary();
    parsed.points.forEach(p => addBoundaryPoint(L.latLng(p.lat, p.lng)));
    state.map.instance.setView([parsed.points[0].lat, parsed.points[0].lng], 19);
    showToast('Boundary auto-populated from title!', 'success');
  });
  showToast('Title document analysed!', 'success');
}

// ============================================================
// BOUNDARY TOOLS — Export & Certificate
// ============================================================
function bindBoundaryTools() {
  document.getElementById('btn-export-geojson').addEventListener('click', exportGeoJSON);
  document.getElementById('btn-export-kml').addEventListener('click', exportKML);
  document.getElementById('btn-download-certificate').addEventListener('click', downloadCertificate);
}

function exportGeoJSON() {
  const pts = state.boundary.points;
  if (pts.length < 3) { showToast('Plot at least 3 boundary points first.', 'warning'); return; }
  const gj = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        parcelId:     `CHZ-${Date.now()}`,
        area_sqm:     state.boundary.area.toFixed(2),
        perimeter_m:  state.boundary.perimeter.toFixed(2),
        owner:        state.wallet.address || 'Unknown',
        timestamp:    new Date().toISOString(),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[...pts.map(p => [p.lng, p.lat]), [pts[0].lng, pts[0].lat]]],
      },
    }],
  };
  triggerDownload(`blockchain-surveyor-${Date.now()}.geojson`, JSON.stringify(gj, null, 2), 'application/geo+json');
  showToast('GeoJSON exported!', 'success');
}

function exportKML() {
  const pts = state.boundary.points;
  if (pts.length < 3) { showToast('Plot at least 3 boundary points first.', 'warning'); return; }
  const coords = [...pts, pts[0]].map(p => `${p.lng},${p.lat},0`).join('\n                ');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Blockchain Surveyor Lot Export</name>
    <Placemark>
      <name>Parcel CHZ-${Date.now()}</name>
      <description>Area: ${state.boundary.area.toFixed(2)} sqm | Perimeter: ${state.boundary.perimeter.toFixed(2)} m</description>
      <Style>
        <LineStyle><color>ff0bf5f5</color><width>2</width></LineStyle>
        <PolyStyle><color>330bf5f5</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>
                ${coords}
        </coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
  triggerDownload(`blockchain-surveyor-${Date.now()}.kml`, kml, 'application/vnd.google-earth.kml+xml');
  showToast('KML exported!', 'success');
}

async function downloadCertificate() {
  const pts = state.boundary.points;
  if (pts.length < 3) { showToast('Plot at least 3 boundary points first.', 'warning'); return; }
  if (!window.jspdf) { showToast('PDF library still loading — try again in a moment.', 'warning'); return; }

  const { jsPDF } = window.jspdf;
  const doc       = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const parcelId  = `CHZ-LOT-${Date.now().toString(36).toUpperCase()}`;
  const now       = new Date().toLocaleString('en-PH');
  const W         = 210;

  // Background
  doc.setFillColor(10, 10, 20);
  doc.rect(0, 0, W, 297, 'F');

  // Gold header bar
  doc.setFillColor(245, 158, 11);
  doc.rect(0, 0, W, 18, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(10, 10, 20);
  doc.text('BLOCKCHAIN SURVEYOR — SOVEREIGN CADASTRAL CERTIFICATE', W / 2, 12, { align: 'center' });

  // Title
  doc.setTextColor(245, 158, 11);
  doc.setFontSize(18);
  doc.text('Certificate of Cadastral Registration', W / 2, 32, { align: 'center' });

  doc.setDrawColor(245, 158, 11);
  doc.setLineWidth(0.5);
  doc.line(20, 38, W - 20, 38);

  // Meta
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(200, 200, 200);
  const meta = [
    ['Parcel ID',          parcelId],
    ['Date Issued',        now],
    ['Owner (Wallet)',     state.wallet.address || 'Not Connected'],
    ['Area',               `${state.boundary.area.toFixed(4)} sqm`],
    ['Perimeter',          `${state.boundary.perimeter.toFixed(4)} m`],
    ['Boundary Nodes',     `${pts.length}`],
    ['RTK Fix Type',       state.rover.fixType],
    ['Satellites Tracked', `${state.rover.satellites}`],
    ['NTRIP Caster',       document.getElementById('ntrip-caster')?.value || 'N/A'],
    ['LGU Approval',       state.cadastral.lguApproved ? 'Approved' : 'Pending'],
    ['Surveyor Stamp',     state.cadastral.surveyorVerified ? 'Verified' : 'Pending'],
    ['Neighbors Signed',   `${state.cadastral.neighborsSigned} / ${state.cadastral.totalNeighbors}`],
  ];

  let y = 48;
  meta.forEach(([label, val]) => {
    doc.setTextColor(120, 120, 140);  doc.text(label + ':', 22, y);
    doc.setTextColor(240, 240, 240);  doc.text(String(val), 80, y);
    y += 7;
  });

  doc.line(20, y + 2, W - 20, y + 2);
  y += 10;

  // Coordinates table
  doc.setTextColor(245, 158, 11);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Boundary Coordinates (WGS84 — ITRF2014)', 22, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  pts.forEach((p, i) => {
    doc.setTextColor(150, 150, 170);
    doc.text(`P${i + 1}`, 22, y);
    doc.setTextColor(220, 220, 220);
    doc.text(`${p.lat.toFixed(8)}° N`, 35, y);
    doc.text(`${p.lng.toFixed(8)}° E`, 95, y);
    y += 6;
    if (y > 270) { doc.addPage(); doc.setFillColor(10,10,20); doc.rect(0,0,W,297,'F'); y = 20; }
  });

  // Footer
  doc.setFontSize(7.5);
  doc.setTextColor(70, 70, 90);
  doc.text('This certificate is generated by the Blockchain Surveyor Sovereign Cadastral System.', W / 2, 282, { align: 'center' });
  doc.text('On-chain registration does not automatically constitute legal title under Philippine law (PD 1529, RA 11057).', W / 2, 287, { align: 'center' });
  doc.text('Consult a licensed Geodetic Engineer and the Register of Deeds for full legal effect.', W / 2, 292, { align: 'center' });

  doc.save(`Blockchain-Surveyor-Certificate-${parcelId}.pdf`);
  showToast('Survey certificate downloaded!', 'success');
}

function triggerDownload(filename, content, mime) {
  const a   = document.createElement('a');
  a.href    = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ============================================================
// SUBDIVISION
// ============================================================
function bindSubdivision() {
  document.getElementById('btn-subdivide-mode').addEventListener('click', () => {
    state.subdivision.active = true;
    state.subdivision.selectedNodes = [];
    document.getElementById('btn-subdivide-mode').classList.add('hidden');
    document.getElementById('btn-cancel-subdivide').classList.remove('hidden');
    document.getElementById('subdivision-sibling-panel').classList.remove('hidden');
    showToast('Subdivision mode: click two nodes to draw split line.', 'info');
  });

  document.getElementById('btn-cancel-subdivide').addEventListener('click', () => {
    clearSubdivision();
  });

  document.getElementById('btn-sign-sibling-1').addEventListener('click', () => {
    stampBtn('btn-sign-sibling-1', 'Sibling #1');
  });
  document.getElementById('btn-sign-sibling-2').addEventListener('click', () => {
    stampBtn('btn-sign-sibling-2', 'Sibling #2');
  });

  document.getElementById('btn-confirm-subdivision').addEventListener('click', confirmSubdivision);
}

function clearSubdivision() {
  state.subdivision.active = false;
  state.subdivision.selectedNodes = [];
  if (state.subdivision.polyline) {
    state.map.instance.removeLayer(state.subdivision.polyline);
    state.subdivision.polyline = null;
  }
  document.getElementById('btn-subdivide-mode').classList.remove('hidden');
  document.getElementById('btn-cancel-subdivide').classList.add('hidden');
  document.getElementById('subdivision-sibling-panel').classList.add('hidden');
  document.getElementById('subdivision-confirm-wrap').classList.add('hidden');

  // Reset highlighted node colors
  state.boundary.markers.forEach((m) => {
    const el = m.getElement()?.querySelector('.b-node');
    if (el) el.style.background = '';
  });
}

function handleSubdivisionNodeClick(marker) {
  const i = state.boundary.markers.indexOf(marker);
  if (i < 0) return;

  if (state.subdivision.selectedNodes.includes(i)) return;

  state.subdivision.selectedNodes.push(i);
  const el = marker.getElement()?.querySelector('.b-node');
  if (el) el.style.background = 'var(--blue-accent)';
  showToast(`Node ${i + 1} selected for split`, 'info');

  if (state.subdivision.selectedNodes.length === 2) {
    drawSubdivisionSplit();
  }
}

function drawSubdivisionSplit() {
  const [idx1, idx2] = state.subdivision.selectedNodes;
  const pts = state.boundary.points;
  const p1 = pts[idx1];
  const p2 = pts[idx2];

  state.subdivision.polyline = L.polyline([p1, p2], {
    color: 'var(--blue-accent)',
    weight: 3,
    dashArray: '6 6'
  }).addTo(state.map.instance);

  const minIdx = Math.min(idx1, idx2);
  const maxIdx = Math.max(idx1, idx2);

  // Split calculations
  const child1Pts = pts.slice(minIdx, maxIdx + 1);
  const child2Pts = [...pts.slice(maxIdx), ...pts.slice(0, minIdx + 1)];

  state.subdivision.child1 = child1Pts;
  state.subdivision.child2 = child2Pts;

  const area1 = calculateArea(child1Pts);
  const area2 = calculateArea(child2Pts);

  state.subdivision.area1 = area1;
  state.subdivision.area2 = area2;

  document.getElementById('subdiv-child-a-area').textContent = area1.toFixed(2);
  document.getElementById('subdiv-child-b-area').textContent = area2.toFixed(2);
  document.getElementById('subdivision-confirm-wrap').classList.remove('hidden');
  showToast('Split line drawn! Ready to commit subdivision.', 'success');
}

async function confirmSubdivision() {
  if (!state.wallet.connected) { showToast('Connect your wallet first.', 'warning'); return; }

  const btn = document.getElementById('btn-confirm-subdivision');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Subdividing lot...';

  const contractAddress = document.getElementById('deployed-contract-address').value.trim();
  let txHash, childAId, childBId, block;

  const child1Pts = state.subdivision.child1;
  const child2Pts = state.subdivision.child2;
  const area1 = state.subdivision.area1;
  const area2 = state.subdivision.area2;

  const sibling1 = document.getElementById('sibling-1-address').value.trim();
  const sibling2 = document.getElementById('sibling-2-address').value.trim();
  const siblings = [sibling1, sibling2].filter(w => /^0x[a-fA-F0-9]{40}$/.test(w));

  if (contractAddress && ethers.isAddress(contractAddress) && window.ethereum) {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(contractAddress, CADASTRAL_CONTRACT_ABI, signer);

      const lastLot = state.myLots[0];
      let parentId = 1;
      if (lastLot && lastLot.parcelId && lastLot.parcelId.includes('CHZ-LOT-')) {
        const idPart = lastLot.parcelId.split('CHZ-LOT-')[1];
        if (!isNaN(idPart)) parentId = Number(idPart);
      }

      // Prepare contract args
      const hash1 = ethers.id(JSON.stringify(child1Pts));
      const hash2 = ethers.id(JSON.stringify(child2Pts));
      const hashes = [hash1, hash2];
      
      const jsons = [JSON.stringify(child1Pts), JSON.stringify(child2Pts)];
      const areas = [Math.round(area1), Math.round(area2)];

      showToast('Confirm subdivision in MetaMask...', 'info');
      const tx = await contract.subdivideLot(parentId, hashes, jsons, areas, siblings);
      showToast('Broadcasting transaction...', 'info');
      
      const receipt = await tx.wait();
      txHash = receipt.hash;
      block = receipt.blockNumber;

      // Extract new Lot IDs
      const lotIds = [];
      for (const log of receipt.logs) {
        try {
          const parsedLog = contract.interface.parseLog(log);
          if (parsedLog && parsedLog.name === 'LotRegistered') {
            lotIds.push(Number(parsedLog.args[0]));
          }
        } catch (e) {}
      }

      childAId = lotIds[0] || (Number(await contract.lotCount()) - 1);
      childBId = lotIds[1] || Number(await contract.lotCount());
      
      showToast('Lot subdivided successfully on-chain!', 'success');
    } catch (err) {
      showToast('Subdivision failed: ' + err.message, 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Commit Subdivision';
      return;
    }
  } else {
    showToast('Running in local simulation mode (No contract address configured).', 'info');
    await sleep(2500);
    txHash = `0x${randomHex(64)}`;
    childAId = `MOCK-A-${Date.now().toString(36).toUpperCase()}`;
    childBId = `MOCK-B-${Date.now().toString(36).toUpperCase()}`;
    block = Math.floor(Math.random() * 9_000_000 + 1_000_000);
  }

  // Create new lots
  const lotA = {
    parcelId: `CHZ-LOT-${childAId}`,
    txHash, block,
    area: area1.toFixed(2),
    perimeter: (area1 * 0.12).toFixed(2),
    points: child1Pts,
    owner: state.wallet.address,
    ts: new Date().toISOString(),
  };

  const lotB = {
    parcelId: `CHZ-LOT-${childBId}`,
    txHash, block,
    area: area2.toFixed(2),
    perimeter: (area2 * 0.12).toFixed(2),
    points: child2Pts,
    owner: state.wallet.address,
    ts: new Date().toISOString(),
  };

  state.myLots.unshift(lotB);
  state.myLots.unshift(lotA);
  saveMyLots();
  renderMyLots();
  
  addLedgerRow(lotB);
  addLedgerRow(lotA);

  clearSubdivision();
  showTxReceipt(txHash, `CHZ-LOT-${childAId} & CHZ-LOT-${childBId}`, block);
  showToast('Subdivision sealed on-chain!', 'success');
}

function stampBtn(id, label) {
  const btn = document.getElementById(id);
  btn.innerHTML        = '<i class="fa-solid fa-check"></i> Signed';
  btn.style.background = 'rgba(16,185,129,0.25)';
  btn.disabled         = true;
  showToast(`${label} signature collected!`, 'success');
}

// ============================================================
// NEIGHBOR CONSENSUS
// ============================================================
function bindNeighborConsensus() {
  document.getElementById('neighbor-wallets-input').addEventListener('input', (e) => {
    const wallets = e.target.value.split('\n').map(w => w.trim()).filter(w => w.startsWith('0x'));
    state.cadastral.totalNeighbors = wallets.length;
    const list = document.getElementById('neighbor-signatures-list');
    if (!wallets.length) {
      list.innerHTML = '<span class="text-muted" style="font-size:0.75rem;text-align:center;display:block;">Add neighbor wallet addresses above.</span>';
      return;
    }
    list.innerHTML = wallets.map((w, i) => `
      <div class="consensus-row" id="n-row-${i}">
        <span style="font-family:monospace;font-size:0.68rem;color:var(--text-muted);">${w.slice(0,8)}…${w.slice(-6)}</span>
        <button class="btn-outline" style="padding:0.2rem 0.5rem;font-size:0.7rem;" onclick="signNeighbor(${i})">
          <i class="fa-solid fa-pen-nib"></i> Sign
        </button>
      </div>`).join('');
  });
}

async function signNeighbor(idx) {
  const row = document.getElementById(`n-row-${idx}`);
  if (!row) return;
  const btn = row.querySelector('button');

  const contractAddress = document.getElementById('deployed-contract-address').value.trim();
  if (contractAddress && ethers.isAddress(contractAddress) && window.ethereum) {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> signing…';
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(contractAddress, CADASTRAL_CONTRACT_ABI, signer);

      const lastLot = state.myLots[0];
      let lotId = 1;
      if (lastLot && lastLot.parcelId && lastLot.parcelId.includes('CHZ-LOT-')) {
        const idPart = lastLot.parcelId.split('CHZ-LOT-')[1];
        if (!isNaN(idPart)) {
          lotId = Number(idPart);
        }
      }

      showToast('Confirm signature transaction in MetaMask...', 'info');
      const tx = await contract.signBoundary(lotId);
      showToast('Submitting signature...', 'info');
      await tx.wait();
      showToast(`Neighbor boundary signature verified on-chain!`, 'success');
    } catch (err) {
      showToast('On-chain signing failed: ' + err.message, 'error');
      btn.disabled  = false;
      btn.innerHTML = '<i class="fa-solid fa-pen-nib"></i> Sign';
      return;
    }
  } else {
    showToast('Running in local simulation mode.', 'info');
  }

  btn.innerHTML        = '<i class="fa-solid fa-check"></i> Signed';
  btn.style.background = 'rgba(16,185,129,0.2)';
  btn.style.borderColor = 'var(--green-accent)';
  btn.disabled         = true;
  state.cadastral.neighborsSigned++;
  if (state.cadastral.neighborsSigned >= 1) advanceTo(4);
  checkRegisterReady();
}

// ============================================================
// NOTARIZATIONS
// ============================================================
function bindNotarizations() {
  document.getElementById('btn-lgu-approve').addEventListener('click', async () => {
    if (!state.wallet.connected) { showToast('Connect wallet first.', 'warning'); return; }

    const btn = document.getElementById('btn-lgu-approve');
    const contractAddress = document.getElementById('deployed-contract-address').value.trim();
    
    if (contractAddress && ethers.isAddress(contractAddress) && window.ethereum) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Notarizing...';
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const contract = new ethers.Contract(contractAddress, CADASTRAL_CONTRACT_ABI, signer);

        const lastLot = state.myLots[0];
        let lotId = 1;
        if (lastLot && lastLot.parcelId && lastLot.parcelId.includes('CHZ-LOT-')) {
          const idPart = lastLot.parcelId.split('CHZ-LOT-')[1];
          if (!isNaN(idPart)) lotId = Number(idPart);
        }

        const isLGU = await contract.authorizedLGUs(state.wallet.address);
        if (!isLGU) {
          showToast('Failed: Your connected wallet is not an authorized LGU official.', 'error');
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-stamp"></i> Seal Barangay Approval';
          return;
        }

        showToast('Confirm LGU approval transaction in MetaMask...', 'info');
        const tx = await contract.approveLGU(lotId);
        showToast('Submitting LGU approval...', 'info');
        await tx.wait();
        showToast('Barangay LGU approval sealed on-chain!', 'success');
      } catch (err) {
        showToast('LGU approval failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-stamp"></i> Seal Barangay Approval';
        return;
      }
    } else {
      showToast('Running in local simulation mode.', 'info');
    }

    state.cadastral.lguApproved = true;
    setText('lgu-notary-address', `Approved — ${new Date().toLocaleDateString('en-PH')}`);
    document.getElementById('lgu-notary-address').style.color = 'var(--green-accent)';
    greenBtn('btn-lgu-approve', 'Approved');
    if (state.cadastral.surveyorVerified) advanceTo(5);
    checkRegisterReady();
  });

  document.getElementById('btn-surveyor-verify').addEventListener('click', async () => {
    if (!state.wallet.connected) { showToast('Connect wallet first.', 'warning'); return; }

    const btn = document.getElementById('btn-surveyor-verify');
    const contractAddress = document.getElementById('deployed-contract-address').value.trim();

    if (contractAddress && ethers.isAddress(contractAddress) && window.ethereum) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const contract = new ethers.Contract(contractAddress, CADASTRAL_CONTRACT_ABI, signer);

        const lastLot = state.myLots[0];
        let lotId = 1;
        if (lastLot && lastLot.parcelId && lastLot.parcelId.includes('CHZ-LOT-')) {
          const idPart = lastLot.parcelId.split('CHZ-LOT-')[1];
          if (!isNaN(idPart)) lotId = Number(idPart);
        }

        const isSurveyor = await contract.authorizedSurveyors(state.wallet.address);
        if (!isSurveyor) {
          showToast('Failed: Your connected wallet is not an authorized Geodetic Surveyor.', 'error');
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Stamp surveyor Seal';
          return;
        }

        showToast('Confirm Surveyor verification transaction in MetaMask...', 'info');
        const tx = await contract.verifySurveyor(lotId);
        showToast('Submitting Surveyor verification...', 'info');
        await tx.wait();
        showToast('Geodetic Surveyor stamp verified on-chain!', 'success');
      } catch (err) {
        showToast('Surveyor verification failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Stamp surveyor Seal';
        return;
      }
    } else {
      showToast('Running in local simulation mode.', 'info');
    }

    state.cadastral.surveyorVerified = true;
    setText('surveyor-notary-address', `Verified — ${new Date().toLocaleDateString('en-PH')}`);
    document.getElementById('surveyor-notary-address').style.color = 'var(--green-accent)';
    greenBtn('btn-surveyor-verify', 'Verified');
    if (state.cadastral.lguApproved) advanceTo(5);
    checkRegisterReady();
  });
}

function checkRegisterReady() {
  document.getElementById('btn-submit-registry').disabled = state.boundary.points.length < 3;
}

// ============================================================
// BLOCKCHAIN REGISTRATION
// ============================================================
function bindRegistration() {
  document.getElementById('btn-submit-registry').addEventListener('click', async () => {
    if (!state.wallet.connected)        { showToast('Connect your wallet first.', 'warning'); return; }
    if (state.boundary.points.length < 3) { showToast('Plot your boundary first.', 'warning'); return; }

    const btn = document.getElementById('btn-submit-registry');
    btn.disabled    = true;
    btn.innerHTML   = '<i class="fa-solid fa-spinner fa-spin"></i> Broadcasting to chain…';

    const contractAddress = document.getElementById('deployed-contract-address').value.trim();
    let txHash, parcelId, block;

    if (contractAddress && ethers.isAddress(contractAddress) && window.ethereum) {
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const contract = new ethers.Contract(contractAddress, CADASTRAL_CONTRACT_ABI, signer);

        const coordsJson = JSON.stringify(state.boundary.points.map(p => ({ lat: p.lat, lng: p.lng })));
        const spatialHash = ethers.id(coordsJson);
        const areaInt = Math.round(state.boundary.area);
        
        const neighbors = document.getElementById('neighbor-wallets-input').value
          .split('\n')
          .map(w => w.trim())
          .filter(w => /^0x[a-fA-F0-9]{40}$/.test(w));

        showToast('Confirm transaction in MetaMask...', 'info');
        const tx = await contract.registerLot(spatialHash, coordsJson, areaInt, neighbors);
        showToast('Transaction submitted! Waiting for confirmation...', 'info');
        
        const receipt = await tx.wait();
        txHash = receipt.hash;
        block = receipt.blockNumber;

        let lotId = 0;
        for (const log of receipt.logs) {
          try {
            const parsedLog = contract.interface.parseLog(log);
            if (parsedLog && parsedLog.name === 'LotRegistered') {
              lotId = Number(parsedLog.args[0]);
              break;
            }
          } catch (e) {}
        }
        if (!lotId || lotId === 0) {
          lotId = Number(await contract.lotCount());
        }

        parcelId = `CHZ-LOT-${lotId}`;
        showToast('Lot registered on-chain successfully!', 'success');
      } catch (err) {
        showToast('On-chain registration failed: ' + err.message, 'error');
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Register Lot';
        return;
      }
    } else {
      showToast('Running in local simulation mode (No contract address configured).', 'info');
      await sleep(2000);
      txHash   = `0x${randomHex(64)}`;
      parcelId = `CHZ-LOT-MOCK-${Date.now().toString(36).toUpperCase()}`;
      block    = Math.floor(Math.random() * 9_000_000 + 1_000_000);
    }

    btn.innerHTML        = '<i class="fa-solid fa-circle-check"></i> Registered On-Chain!';
    btn.style.background = 'rgba(16,185,129,0.25)';
    btn.style.borderColor = 'rgba(16,185,129,0.5)';

    // Persist lot
    const lot = {
      parcelId, txHash, block,
      area:      state.boundary.area.toFixed(2),
      perimeter: state.boundary.perimeter.toFixed(2),
      points:    state.boundary.points.map(p => ({ lat: p.lat, lng: p.lng })),
      owner:     state.wallet.address,
      ts:        new Date().toISOString(),
    };
    state.myLots.unshift(lot);
    saveMyLots();
    renderMyLots();
    addLedgerRow(lot);
    showTxReceipt(txHash, parcelId, block);
    advanceTo(6);
    showToast('Lot sealed on the Sovereign Cadastral Ledger!', 'success');
  });
}

function showTxReceipt(txHash, parcelId, block) {
  setText('tx-receipt-parcel-id', parcelId);
  setText('tx-receipt-hash',      `${txHash.slice(0, 22)}…${txHash.slice(-8)}`);
  setText('tx-receipt-block',     `#${block.toLocaleString()}`);
  setText('tx-receipt-time',      new Date().toLocaleString('en-PH'));
  const link = document.getElementById('tx-explorer-link');
  if (link) {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    link.href = isLocal ? `http://localhost:8080/explorer/` : `https://cheeseblockchain.com/explorer/`;
  }
  document.getElementById('tx-receipt-modal').classList.remove('hidden');
}

function addLedgerRow(lot) {
  const tbody = document.getElementById('ledger-history-rows');
  // Remove the empty-state row if present
  const empty = tbody.querySelector('td[colspan="8"]');
  if (empty) empty.closest('tr').remove();
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td style="font-family:monospace;color:var(--cheese-gold);font-weight:700;">${lot.parcelId}</td>
    <td style="font-family:monospace;font-size:0.65rem;">${lot.txHash.slice(0, 20)}…</td>
    <td>${parseFloat(lot.area).toLocaleString()} sqm</td>
    <td style="font-family:monospace;font-size:0.65rem;">${lot.owner ? lot.owner.slice(0, 10) + '…' : '—'}</td>
    <td>${state.cadastral.neighborsSigned} / ${state.cadastral.totalNeighbors || 0}</td>
    <td style="text-align:center;">${state.cadastral.surveyorVerified ? '✅' : '❌'}</td>
    <td style="text-align:center;">${state.cadastral.lguApproved       ? '✅' : '❌'}</td>
    <td><span class="status-pill ${state.rover.fixType === 'RTK Fixed' ? 'connected' : 'partial'}">${state.rover.fixType}</span></td>`;
  tbody.insertBefore(tr, tbody.firstChild);
}

// ============================================================
// ENCROACHMENT RESOLUTION
// ============================================================
function bindEncroachmentResolution() {
  document.getElementById('btn-resolve-encroachment').addEventListener('click', () => {
    document.getElementById('encroachment-modal').classList.remove('hidden');
  });
  document.getElementById('btn-resolve-request-meeting').addEventListener('click', () => {
    document.getElementById('encroachment-modal').classList.add('hidden');
    showToast('On-chain meeting request sent to neighbor wallet.', 'success');
  });
  document.getElementById('btn-resolve-file-dispute').addEventListener('click', () => {
    document.getElementById('encroachment-modal').classList.add('hidden');
    showToast('Boundary dispute filed with Barangay Lupon.', 'success');
  });
  document.getElementById('btn-resolve-adjust-boundary').addEventListener('click', () => {
    document.getElementById('encroachment-modal').classList.add('hidden');
    document.getElementById('encroachment-warning').classList.add('hidden');
    showToast('Drag any boundary node to adjust the overlap.', 'info');
  });
}

// ============================================================
// MY LOTS
// ============================================================
function bindMyLots() {
  document.getElementById('btn-my-lots-toggle').addEventListener('click', () => {
    document.getElementById('my-lots-panel').classList.toggle('hidden');
    const icon = document.querySelector('#btn-my-lots-toggle i');
    if (icon) icon.className = document.getElementById('my-lots-panel').classList.contains('hidden')
      ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
  });
}

function renderMyLots() {
  const el = document.getElementById('my-lots-list');
  if (!el) return;
  if (!state.myLots.length) {
    el.innerHTML = '<p class="text-muted" style="font-size:0.75rem;text-align:center;">No lots registered yet.</p>';
    return;
  }
  el.innerHTML = state.myLots.map(lot => `
    <div class="my-lot-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:monospace;font-size:0.68rem;color:var(--cheese-gold);font-weight:700;">${lot.parcelId}</span>
        <span style="font-size:0.65rem;color:var(--text-muted);">${new Date(lot.ts).toLocaleDateString('en-PH')}</span>
      </div>
      <div style="font-size:0.72rem;margin-top:3px;color:var(--text-muted);">
        📐 ${parseFloat(lot.area).toLocaleString()} sqm &nbsp;·&nbsp; 📍 ${lot.points.length} nodes
      </div>
      <div style="font-size:0.62rem;color:rgba(255,255,255,0.3);font-family:monospace;margin-top:2px;">${lot.txHash.slice(0, 22)}…</div>
    </div>`).join('');
}

function saveMyLots()  { localStorage.setItem('surveyor_lots', JSON.stringify(state.myLots)); }
function loadMyLots()  { try { state.myLots = JSON.parse(localStorage.getItem('surveyor_lots') || '[]'); } catch { state.myLots = []; } }

// ============================================================
// LEDGER SEARCH
// ============================================================
function bindLedgerSearch() {
  document.getElementById('ledger-search-input').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#ledger-history-rows tr').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(msg, type = 'info') {
  const wrap  = document.getElementById('toast-container');
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  const t     = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${msg}</span>`;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 320); }, 3600);
}

// ============================================================
// ONBOARDING
// ============================================================
function showOnboarding() {
  if (!localStorage.getItem('surveyor_onboarded')) {
    setTimeout(() => {
      document.getElementById('onboarding-modal').classList.remove('hidden');
    }, 800);
    localStorage.setItem('surveyor_onboarded', '1');
  }
  document.getElementById('btn-onboarding-close').addEventListener('click', () => {
    document.getElementById('onboarding-modal').classList.add('hidden');
    localStorage.setItem('surveyor_onboarded', '1');
  });
}

// ============================================================
// MODAL — close on overlay click
// ============================================================
function bindModals() {
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.add('hidden'); });
  });
}

// ============================================================
// UTILITIES
// ============================================================
function setText(id, val)       { const e = document.getElementById(id); if (e) e.textContent = val; }
function setClass(id, cls)      { const e = document.getElementById(id); if (e) e.className    = cls; }
function sleep(ms)              { return new Promise(r => setTimeout(r, ms)); }
function randomHex(len)         { return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join(''); }
function greenBtn(id, label)    {
  const b = document.getElementById(id);
  if (!b) return;
  b.innerHTML        = `<i class="fa-solid fa-check"></i> ${label}`;
  b.style.background = 'rgba(16,185,129,0.2)';
  b.style.borderColor = 'rgba(16,185,129,0.4)';
  b.disabled         = true;
}
