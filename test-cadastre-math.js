/*
 * Blockchain Surveyor - Mathematical Verification Test Suite
 * Validates coordinate processing, polygon area calculation, and boundary overlaps.
 */

const assert = require('assert');

// Mock helpers extracted from app.js to run in Node environment
const latRefDefault = 14.5995;
const lonRefDefault = 120.9842;

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

    const latDegrees = parseFloat(rawLat.substring(0, 2));
    const latMinutes = parseFloat(rawLat.substring(2));
    let latDecimal = latDegrees + (latMinutes / 60);
    if (latDirection === 'S') latDecimal = -latDecimal;

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

// --- Run Tests ---
console.log("🏁 Starting Blockchain Surveyor Mathematical Verification tests...");

// Test 1: NMEA GNGGA Sentence parsing accuracy
const nmeaSentence = "$GNGGA,161229.487,1435.9284,N,12058.9102,E,4,24,0.85,12.4,M,0.0,M,3.2,0210*4A";
const decoded = parseGNGGA(nmeaSentence);
assert.ok(decoded, "Should successfully parse GNGGA string");
assert.strictEqual(decoded.fixQuality, 4, "Should decode RTK Fixed status correctly");
assert.ok(Math.abs(decoded.lat - (14 + 35.9284/60)) < 0.000001, "Latitude decimal conversion should be accurate");
assert.ok(Math.abs(decoded.lng - (120 + 58.9102/60)) < 0.000001, "Longitude decimal conversion should be accurate");
console.log("✅ Test 1 Passed: NMEA GNGGA decimal minute decoding is fully accurate.");

// Test 2: Local Tangent Area Calculations (Shoelace Formula)
// Define a simple square lot: 100m x 100m = 10,000 sqm
const coordsSquare = [
    projectToLatLng(-50, -50),
    projectToLatLng(-50, 50),
    projectToLatLng(50, 50),
    projectToLatLng(50, -50)
];
const area = calculateArea(coordsSquare);
assert.ok(Math.abs(area - 10000) < 0.01, "Plotted 100m square area should calculate to exactly 10,000 sqm");
console.log("✅ Test 2 Passed: Shoelace Area Calculator on localized projection matches exact flat geometry.");

// Test 3: Self-intersecting polygon boundary alerts
// Define a self-intersecting polygon (hourglass shape)
const coordsSelfIntersect = [
    projectToLatLng(-50, -50),
    projectToLatLng(50, 50),
    projectToLatLng(-50, 50),
    projectToLatLng(50, -50)
];
assert.strictEqual(hasSelfIntersection(coordsSquare), false, "Normal square polygon should not flag self-intersection");
assert.strictEqual(hasSelfIntersection(coordsSelfIntersect), true, "Hourglass self-intersecting polygon should successfully be flagged");
console.log("✅ Test 3 Passed: Self-intersecting polygons are correctly caught by segment crossing calculations.");

// Test 4: OCR metes and bounds text parsing
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

const mockTitleText = `
SURVEY PLAN OF LOT 102-A
Point 1 to Point 2: N 45 deg 00 min E, 100.00 m
Point 2 to Point 3: S 45 deg 00 min E, 100.00 m
Point 3 to Point 4: S 45 deg 00 min W, 100.00 m
Point 4 to Point 1: N 45 deg 00 min W, 100.00 m
`;

const ocrParsed = parseMetesAndBounds(mockTitleText);
assert.strictEqual(ocrParsed.length, 4, "Should parse exactly 4 vertices from metes and bounds description");
const ocrArea = calculateArea(ocrParsed);
assert.ok(Math.abs(ocrArea - 10000) < 0.05, "Parsed OCR metes and bounds should calculate to a 10,000 sqm parcel area");
console.log("✅ Test 4 Passed: AI OCR metes and bounds bearings-to-coordinates vectorizer is mathematically correct.");

console.log("🎉 ALL MATHEMATICAL AUDIT VERIFICATION TESTS PASSED!");
