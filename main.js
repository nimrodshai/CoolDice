// Using global THREE and THREE.OrbitControls from non-module scripts
// Guard: if THREE failed to load, show a helpful message and stop.
if (typeof window.THREE === "undefined") {
  const warn = document.createElement("div");
  warn.style.position = "fixed";
  warn.style.inset = "16px";
  warn.style.background = "#1f2937";
  warn.style.color = "#fff";
  warn.style.border = "1px solid #374151";
  warn.style.borderRadius = "12px";
  warn.style.padding = "12px 14px";
  warn.style.zIndex = "9999";
  warn.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  warn.textContent = "Failed to load Three.js from CDN. Please check your network, then reload this page.";
  document.body.appendChild(warn);
  // Make buttons at least give feedback
  const rb = document.getElementById("roll-btn");
  const eb = document.getElementById("edit-btn");
  if (rb) rb.addEventListener("click", () => alert("Three.js not loaded yet."));
  if (eb) eb.addEventListener("click", () => alert("Three.js not loaded yet."));
  // Abort script
  // eslint-disable-next-line no-undef
  throw new Error("THREE not available");
}

// Basic deterministic PRNG for roll animations
function createRandom(seed = Math.random() * 1e9) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s & 0xfffffff) / 0xfffffff;
  };
}

// Easing (decelerate)
function easeOutCubic(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

const appState = {
  numDice: 2,
  diceColor: "#ffffff",
  pipColor: "#000000",
  background: "#0e0e0e",
  edgeRadiusPercent: 0,
  rollMode: "spin", // or "physics"
  bgMode: "color",
};

// Fixed, non-editable edge radius percent
const FIXED_RADIUS_PERCENT = 12;

// Save/load from localStorage
const STORAGE_KEY = "dice-roller-settings-v1";
const SETTINGS_VERSION = 2;
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const needsMigration = !("version" in data) || (typeof data.version === 'number' && data.version < SETTINGS_VERSION);
    if (needsMigration) {
      if (!data.rollMode || data.rollMode === 'physics') data.rollMode = 'spin';
      data.version = SETTINGS_VERSION;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
    Object.assign(appState, data);
  } catch {}
}
function saveState() {
  appState.version = SETTINGS_VERSION;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}
loadState();
// Enforce fixed radius regardless of saved settings
appState.edgeRadiusPercent = FIXED_RADIUS_PERCENT;

// Three.js scene setup
const container = document.getElementById("three-root");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(
  container.clientWidth || window.innerWidth,
  container.clientHeight || window.innerHeight
);
renderer.shadowMap.enabled = true;
if (THREE.ACESFilmicToneMapping) renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(appState.background);

const initialW = container.clientWidth || window.innerWidth || 800;
const initialH = container.clientHeight || window.innerHeight || 600;
const camera = new THREE.PerspectiveCamera(45, initialW / initialH, 0.1, 150);
camera.position.set(6, 9, 10);
camera.lookAt(0, 0, 0);

let controls = { update: function () {} };
try {
  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 5;
    controls.maxDistance = 20;
  }
} catch (err) {
  // Controls not available; continue without orbit controls
}

// Lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.6);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 10, 7);
dir.castShadow = true;
const isSmallScreen = (initialW || 800) < 640;
dir.shadow.mapSize.set(isSmallScreen ? 1024 : 2048, isSmallScreen ? 1024 : 2048);
scene.add(dir);
// Rim lights to enhance edge highlights
const rim1 = new THREE.PointLight(0xffffff, 0.35, 0);
rim1.position.set(-6, 8, -6);
scene.add(rim1);
const rim2 = new THREE.PointLight(0xffffff, 0.25, 0);
rim2.position.set(6, 5, -4);
scene.add(rim2);

// Floor
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.ShadowMaterial({ opacity: 0.25 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
floor.receiveShadow = true;
scene.add(floor);

// Physics (Cannon.js)
if (typeof window.CANNON === "undefined") {
  const warn = document.createElement("div");
  warn.style.position = "fixed";
  warn.style.left = "16px";
  warn.style.bottom = "16px";
  warn.style.background = "#7c2d12";
  warn.style.color = "#fff";
  warn.style.border = "1px solid #b45309";
  warn.style.borderRadius = "10px";
  warn.style.padding = "8px 10px";
  warn.style.zIndex = "9999";
  warn.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  warn.textContent = "Physics library failed to load; using simple spin animation instead.";
  document.body.appendChild(warn);
}

const world = typeof window.CANNON !== "undefined" ? new CANNON.World() : null;
let groundMat = null;
let diceMat = null;
let arenaBodies = [];
if (world) {
  // Faster falling for snappier physics
  world.gravity.set(0, -14.7, 0);
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = 12;
  world.allowSleep = true;

  groundMat = new CANNON.Material("ground");
  diceMat = new CANNON.Material("dice");
  const contact = new CANNON.ContactMaterial(groundMat, diceMat, {
    friction: 0.2,
    restitution: 0.3,
  });
  world.addContactMaterial(contact);

  // Ground body (infinite plane)
  const groundBody = new CANNON.Body({ mass: 0, material: groundMat });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);
}

function computeArenaSize() {
  const count = Math.max(1, diceGroup.children.length || appState.numDice || 1);
  const spacing = 1.2;
  const perRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / perRow);
  const width = (perRow - 1) * spacing + 2.0;
  const depth = (rows - 1) * spacing + 2.0;
  return { width, depth };
}

function updateArenaBounds() {
  if (!world) return;
  // Remove previous
  arenaBodies.forEach((b) => world.removeBody(b));
  arenaBodies = [];
  const { width, depth } = computeArenaSize();
  const margin = 1.5;
  const halfW = width / 2 + margin;
  const halfD = depth / 2 + margin;
  const wallThickness = 0.3;
  const wallHeight = 3.5;
  const hH = wallHeight / 2;

  // +Z wall (far)
  let body = new CANNON.Body({ mass: 0, material: groundMat || undefined });
  body.addShape(new CANNON.Box(new CANNON.Vec3(halfW, hH, wallThickness / 2)));
  body.position.set(0, hH, halfD + wallThickness / 2);
  world.addBody(body); arenaBodies.push(body);

  // -Z wall (near)
  body = new CANNON.Body({ mass: 0, material: groundMat || undefined });
  body.addShape(new CANNON.Box(new CANNON.Vec3(halfW, hH, wallThickness / 2)));
  body.position.set(0, hH, -halfD - wallThickness / 2);
  world.addBody(body); arenaBodies.push(body);

  // +X wall (right)
  body = new CANNON.Body({ mass: 0, material: groundMat || undefined });
  body.addShape(new CANNON.Box(new CANNON.Vec3(wallThickness / 2, hH, halfD)));
  body.position.set(halfW + wallThickness / 2, hH, 0);
  world.addBody(body); arenaBodies.push(body);

  // -X wall (left)
  body = new CANNON.Body({ mass: 0, material: groundMat || undefined });
  body.addShape(new CANNON.Box(new CANNON.Vec3(wallThickness / 2, hH, halfD)));
  body.position.set(-halfW - wallThickness / 2, hH, 0);
  world.addBody(body); arenaBodies.push(body);
}

// Dice factory
function createDiceMaterial(diceColor, pipColor) {
  const size = 1024;
  const pipR = Math.round(size * 0.08);
  const makeFace = (count) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = diceColor;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = pipColor;

    const cx = size / 2;
    const cy = size / 2;
    const off = size * 0.25;
    const positions = {
      1: [[0, 0]],
      2: [[-off, -off], [off, off]],
      3: [[-off, -off], [0, 0], [off, off]],
      4: [[-off, -off], [off, -off], [-off, off], [off, off]],
      5: [[-off, -off], [off, -off], [0, 0], [-off, off], [off, off]],
      6: [[-off, -off*1.1], [off, -off*1.1], [-off, 0], [off, 0], [-off, off*1.1], [off, off*1.1]],
    };

    const drawPip = (x, y) => {
      ctx.beginPath();
      ctx.arc(cx + x, cy + y, pipR, 0, Math.PI * 2);
      ctx.fill();
    };
    positions[count].forEach(([x, y]) => drawPip(x, y));
    return new THREE.CanvasTexture(canvas);
  };

  // Order for a standard dice mesh so that opposite faces sum to 7
  const textures = [
    makeFace(1), // right
    makeFace(6), // left
    makeFace(2), // top
    makeFace(5), // bottom
    makeFace(3), // front
    makeFace(4), // back
  ];
  return textures.map((t) => {
    t.anisotropy = Math.min(16, (renderer.capabilities.getMaxAnisotropy && renderer.capabilities.getMaxAnisotropy()) || 8);
    t.generateMipmaps = true;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return new THREE.MeshPhysicalMaterial({
      map: t,
      roughness: 0.35,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.12,
      ior: 1.5,
      specularIntensity: 1.0,
    });
  });
}

function createDie(size = 1, diceColor = "#ffffff", pipColor = "#000000") {
  const maxPct = 49;
  const pct = Math.max(0, Math.min(maxPct, FIXED_RADIUS_PERCENT));
  let geometry;
  if (pct <= 0) {
    geometry = new THREE.BoxGeometry(size, size, size);
  } else {
    const radius = Math.min(size * (pct / 100), size * 0.49);
    if (THREE.RoundedBoxGeometry) {
      // Signature: (width, height, depth, radius, smoothness)
      geometry = new THREE.RoundedBoxGeometry(size, size, size, radius, 12);
    } else {
      // Fallback: approximate rounded cube by spherifying corners on a subdivided box
      const segments = 10;
      geometry = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
      geometry = geometry.toNonIndexed();
      const pos = geometry.attributes.position;
      const v = new THREE.Vector3();
      const half = size / 2;
      const core = half - radius;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const sx = Math.sign(v.x), sy = Math.sign(v.y), sz = Math.sign(v.z);
        const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
        const cx = Math.max(ax - core, 0);
        const cy = Math.max(ay - core, 0);
        const cz = Math.max(az - core, 0);
        const m = Math.hypot(cx, cy, cz);
        let nx = 0, ny = 0, nz = 0;
        if (m > 0) { nx = cx / m; ny = cy / m; nz = cz / m; }
        const nxPos = Math.min(ax, core) + nx * radius;
        const nyPos = Math.min(ay, core) + ny * radius;
        const nzPos = Math.min(az, core) + nz * radius;
        v.set(sx * nxPos, sy * nyPos, sz * nzPos);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.computeVertexNormals();
    }
  }
  const materials = createDiceMaterial(diceColor, pipColor);
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.userData = { size };
  return mesh;
}

function setDieToFace(mesh, faceValue) {
  // Orient the cube so that the requested faceValue is on +Y (top).
  // With our material order: +x:1, -x:6, +y:2, -y:5, +z:3, -z:4
  // Mappings derived to bring each source face normal onto +Y.
  const rotations = {
    1: new THREE.Euler(0, 0, Math.PI / 2),     // +x -> +y (Rz +90deg)
    2: new THREE.Euler(0, 0, 0),               // +y already on top
    3: new THREE.Euler(-Math.PI / 2, 0, 0),    // +z -> +y (Rx -90deg)
    4: new THREE.Euler(Math.PI / 2, 0, 0),     // -z -> +y (Rx +90deg)
    5: new THREE.Euler(Math.PI, 0, 0),         // -y -> +y (Rx 180deg)
    6: new THREE.Euler(0, 0, -Math.PI / 2),    // -x -> +y (Rz -90deg)
  };
  const e = rotations[faceValue] || rotations[2];
  mesh.rotation.set(e.x, e.y, e.z);
}

// Dice management
const diceGroup = new THREE.Group();
scene.add(diceGroup);
let diceBodies = [];

function layoutDice() {
  const count = diceGroup.children.length;
  if (count === 0) return;
  const spacing = 1.2;
  if (appState.rollMode === 'spin') {
    // Single centered row
    const startX = -((count - 1) * spacing) / 2;
    diceGroup.children.forEach((mesh, i) => {
      mesh.position.set(startX + i * spacing, 0.5, 0);
    });
  } else {
    // Grid layout
    const perRow = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / perRow);
    const startX = -((perRow - 1) * spacing) / 2;
    const startZ = -((rows - 1) * spacing) / 2;
    diceGroup.children.forEach((mesh, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      mesh.position.set(startX + col * spacing, 0.5, startZ + row * spacing);
    });
  }
}

function resetDiceTransformsForMode() {
  // Reposition per mode and zero rotations
  layoutDice();
  diceGroup.children.forEach((mesh) => {
    mesh.rotation.set(0, 0, 0);
    mesh.quaternion.set(0, 0, 0, 1);
    mesh.position.y = 0.5;
    const body = mesh.userData.body;
    if (world && body) {
      body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.quaternion.set(0, 0, 0, 1);
      body.sleep();
    }
  });
}

function rebuildDice() {
  // Remove existing
  while (diceGroup.children.length) {
    const m = diceGroup.children.pop();
    m.geometry.dispose();
    if (Array.isArray(m.material)) m.material.forEach((mat) => mat.map && mat.map.dispose());
  }
  // Remove existing bodies
  if (world && diceBodies.length) {
    diceBodies.forEach((b) => world.removeBody(b));
  }
  diceBodies = [];
  // Create new
  for (let i = 0; i < appState.numDice; i++) {
    const die = createDie(1, appState.diceColor, appState.pipColor);
    diceGroup.add(die);
    if (world) {
      // Use a slightly smaller collision box to emulate rounded edges
      const inset = Math.max(0, Math.min(0.24, (FIXED_RADIUS_PERCENT || 0) / 100 * 0.5));
      const he = 0.5 - Math.max(0.02, inset * 0.8); // minimum inset to avoid jitter
      const shape = new CANNON.Box(new CANNON.Vec3(he, he, he));
      const body = new CANNON.Body({ mass: 1, material: world.materials?.find?.((m) => m.name === "dice") || new CANNON.Material("dice") });
      body.addShape(shape);
      body.allowSleep = true;
      body.sleepSpeedLimit = 0.05;
      body.sleepTimeLimit = 0.5;
      world.addBody(body);
      die.userData.body = body;
      diceBodies.push(body);
    }
  }
  layoutDice();
  if (world) resetPhysicsPositions();
  positionCamera();
  updateArenaBounds();
}

rebuildDice();

// Resize handling
function onResize() {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  const small = w < 640;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  positionCamera();
  updateArenaBounds();
}
window.addEventListener("resize", onResize);
onResize();

function resetPhysicsPositions() {
  const rng = createRandom();
  const count = diceGroup.children.length;
  if (!world || !count) return;
  const spacing = 1.2;
  const perRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / perRow);
  const startX = -((perRow - 1) * spacing) / 2;
  const startZ = -((rows - 1) * spacing) / 2;
  diceGroup.children.forEach((mesh, i) => {
    const body = mesh.userData.body;
    if (!body) return;
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = startX + col * spacing + (rng() - 0.5) * 0.6;
    const z = startZ + row * spacing + (rng() - 0.5) * 0.6;
    const y = 6 + rng() * 3; // higher drop
    body.position.set(x, y, z);
    body.velocity.set((rng() - 0.5) * 4, -2 - rng() * 2, (rng() - 0.5) * 4);
    body.angularVelocity.set((rng() - 0.5) * 14, (rng() - 0.5) * 14, (rng() - 0.5) * 14);
    body.quaternion.setFromEuler(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    body.wakeUp();
  });
}

// Roll handler
function rollDice() {
  if (appState.rollMode === 'physics' && world) {
    resetPhysicsPositions();
    return;
  }
  if (appState.rollMode === 'spin') {
    // Layout dice in a single centered row
    const count = diceGroup.children.length;
    const spacing = 1.2;
    const startX = -((count - 1) * spacing) / 2;
    diceGroup.children.forEach((mesh, i) => {
      mesh.position.set(startX + i * spacing, 0.5, 0);
    });
    // Spin each die independently around X and Y
    const rng = createRandom();
    // Spin counts measured in quarter-turns (90° units). Range 4–14 quarters = 1–3.5 full turns
    const quartersX = diceGroup.children.map(() => 4 + Math.floor(rng() * 11));
    const quartersY = diceGroup.children.map(() => 4 + Math.floor(rng() * 11));
    const durX = diceGroup.children.map(() => 800 + Math.floor(rng() * 400)); // 0.8-1.2s
    const durY = diceGroup.children.map(() => 800 + Math.floor(rng() * 400));
    const start = performance.now();
    const baseRot = diceGroup.children.map((m) => m.rotation.clone());
    isRowSpinning = true;
    function tickSpin(now) {
      let allDone = true;
      const elapsed = now - start;
      diceGroup.children.forEach((mesh, i) => {
        const px = Math.min(1, elapsed / durX[i]);
        const py = Math.min(1, elapsed / durY[i]);
        if (px < 1 || py < 1) allDone = false;
        const angleX = quartersX[i] * (Math.PI / 2) * easeOutCubic(px);
        const angleY = quartersY[i] * (Math.PI / 2) * easeOutCubic(py);
        mesh.rotation.x = baseRot[i].x + angleX;
        mesh.rotation.y = baseRot[i].y + angleY;
      });
      if (!allDone) requestAnimationFrame(tickSpin);
      else isRowSpinning = false;
    }
    requestAnimationFrame(tickSpin);
    return;
  }
  // Fallback simple spin when physics missing and not using custom spin mode
  const rng = createRandom();
  const duration = 1200 + rng() * 800;
  const start = performance.now();
  function animate(now) {
    const t = Math.min(1, (now - start) / duration);
    const spinIntensity = (1 - t) * 16 + 2;
    diceGroup.children.forEach((mesh, i) => {
      mesh.rotation.x += (rng() - 0.5) * 0.5 * spinIntensity * 0.016;
      mesh.rotation.y += (rng() - 0.5) * 0.6 * spinIntensity * 0.016;
      mesh.rotation.z += (rng() - 0.5) * 0.4 * spinIntensity * 0.016;
      mesh.position.y = 0.5 + Math.abs(Math.sin((now + i * 80) * 0.02)) * 0.1 * (1 - t);
    });
    if (t < 1) requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

// Render + physics loop
let lastTime;
let isRowSpinning = false;
function tick(now) {
  if (world) {
    if (lastTime === undefined) lastTime = now;
    const dt = Math.min(0.033, (now - lastTime) / 1000);
    world.step(1 / 60, dt, 3);
    // Sync meshes only for physics mode
    if (appState.rollMode === 'physics' && !isRowSpinning) {
      diceGroup.children.forEach((mesh) => {
        const body = mesh.userData.body;
        if (!body) return;
        mesh.position.set(body.position.x, body.position.y, body.position.z);
        mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      });
    }
    lastTime = now;
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Camera framing based on number of dice and screen size
function positionCamera() {
  const count = Math.max(1, diceGroup.children.length || appState.numDice || 1);
  const spacing = 1.2;
  const perRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / perRow);
  const width = (perRow - 1) * spacing + 2.0;
  const depth = (rows - 1) * spacing + 2.0;
  // compute distance needed to fit both width and depth considering FOV
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect || (initialW / initialH);
  const vDist = (Math.max(width, depth) / 2) / Math.tan(fov / 2);
  // For horizontal, approximate horizontal FOV from vertical fov and aspect
  const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
  const hDist = (width / 2) / Math.tan(hFov / 2);
  const needed = Math.max(vDist, hDist) * 1.2; // add some margin

  const elev = needed * 0.9;
  const dist = needed * 1.1;
  camera.position.set(dist * 0.7, elev, dist);
  camera.lookAt(0, 0, 0);
}

// UI wiring
const rollBtn = document.getElementById("roll-btn");
const editBtn = document.getElementById("edit-btn");
const settingsDialog = document.getElementById("settings-dialog");
const settingsForm = document.getElementById("settings-form");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const pickerDialog = document.getElementById("color-picker");
const pickerBackdrop = document.getElementById("picker-backdrop");
const swatchGrid = document.getElementById("swatch-grid");
const pickerTitle = document.getElementById("picker-title");
const bgMode = document.getElementById("bg-mode");
const bgColorRow = document.getElementById("bg-color-row");
const bgGradientRows = document.getElementById("bg-gradient-rows");
const bgImageRow = document.getElementById("bg-image-row");
const bgImageChoose = document.getElementById("bg-image-choose");
const bgImageInput = document.getElementById("bg-image-input");
const stepperDec = document.getElementById("stepper-dec");
const stepperInc = document.getElementById("stepper-inc");
const numDiceDisplay = document.getElementById("num-dice-display");

rollBtn.addEventListener("click", rollDice);
function openSheet() {
  if (typeof settingsDialog.showModal === "function") {
    settingsDialog.style.opacity = "0";
    if (sheetBackdrop) sheetBackdrop.classList.add("active");
    settingsDialog.showModal();
    settingsDialog.animate([
      { transform: "translate(-50%, 40px)", opacity: 0 },
      { transform: "translate(-50%, 0px)", opacity: 1 }
    ], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
  } else {
    settingsDialog.setAttribute("open", "");
    if (sheetBackdrop) sheetBackdrop.classList.add("active");
  }
}

function closeSheet() {
  if (!settingsDialog.open) return;
  const anim = settingsDialog.animate([
    { transform: "translate(-50%, 0px)", opacity: 1 },
    { transform: "translate(-50%, 40px)", opacity: 0 }
  ], { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
  anim.onfinish = () => {
    settingsDialog.close();
    if (sheetBackdrop) sheetBackdrop.classList.remove("active");
  };
}

editBtn.addEventListener("click", () => {
  // set form values from state
  settingsForm.numDice.value = appState.numDice;
  settingsForm.diceColor.value = appState.diceColor;
  settingsForm.pipColor.value = appState.pipColor;
  settingsForm.background.value = appState.background;
  const countLabel = document.getElementById("count-label");
  if (countLabel) countLabel.textContent = String(appState.numDice);
  const dDot = document.querySelector('#dice-color-chip .dot'); if (dDot) dDot.style.background = appState.diceColor;
  const pDot = document.querySelector('#pip-color-chip .dot'); if (pDot) pDot.style.background = appState.pipColor;
  const bDot = document.querySelector('#bg-color-chip .dot'); if (bDot) bDot.style.background = appState.background;
  // gradient state defaults
  const startDot = document.querySelector('#bg-start-chip .dot'); if (startDot) startDot.style.background = appState.bgStart || '#101010';
  const endDot = document.querySelector('#bg-end-chip .dot'); if (endDot) endDot.style.background = appState.bgEnd || '#30180a';
  if (numDiceDisplay) numDiceDisplay.textContent = String(appState.numDice);
  // set roll style segmented control
  const seg = document.getElementById("roll-style");
  if (seg) {
    seg.querySelectorAll('button').forEach((b)=>b.classList.remove('active'));
    const btn = seg.querySelector(`[data-mode="${appState.rollMode}"]`);
    if (btn) btn.classList.add('active');
  }
  // set bg mode control
  if (bgMode) {
    bgMode.querySelectorAll('button').forEach((b)=>b.classList.toggle('active', b.getAttribute('data-mode') === (appState.bgMode || 'color')));
    showBgMode(appState.bgMode || 'color');
  }
  openSheet();
});

const cancelBtn = document.getElementById("cancel-settings");
if (cancelBtn) cancelBtn.addEventListener("click", (e) => { e.preventDefault(); closeSheet(); });

document.getElementById("save-settings").addEventListener("click", (e) => {
  e.preventDefault();
  const numDice = Math.max(1, Math.min(10, parseInt(settingsForm.numDice.value || "2", 10)));
  const diceColor = settingsForm.diceColor.value || "#ffffff";
  const pipColor = settingsForm.pipColor.value || "#000000";
  const background = settingsForm.background.value || "#0e0e0e";
  const edgeRadiusPercent = FIXED_RADIUS_PERCENT;
  const rollMode = appState.rollMode || "spin";

  const changed =
    numDice !== appState.numDice ||
    diceColor !== appState.diceColor ||
    pipColor !== appState.pipColor ||
    background !== appState.background;

  appState.numDice = numDice;
  appState.diceColor = diceColor;
  appState.pipColor = pipColor;
  appState.background = background;
  appState.edgeRadiusPercent = edgeRadiusPercent;
  appState.rollMode = rollMode;

  saveState();

  if (changed) {
    scene.background = new THREE.Color(appState.background);
    rebuildDice();
  }
  closeSheet();
});

// Close when clicking backdrop (outside content)
settingsDialog.addEventListener("click", (e) => {
  const rect = settingsDialog.getBoundingClientRect();
  const inDialog = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inDialog) closeSheet();
});

if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeSheet);

// Color picker bottom sheet
const PALETTE = [
  "#000000","#202124","#5f6368","#9aa0a6","#dadce0","#ffffff",
  "#1d3557","#264653","#2a9d8f","#16a34a","#84cc16","#eab308","#ea580c","#dc2626","#ef4444",
  "#0ea5e9","#2563eb","#7c3aed","#d946ef","#ec4899","#f97316","#f59e0b","#22c55e","#14b8a6",
  "#b91c1c","#b45309","#a16207","#4d7c0f","#065f46","#155e75","#1e3a8a","#4c1d95"
];

function openPicker(target) {
  const title = target === "dice" ? "Dice Color" : target === "pip" ? "Dots Color" : "Background";
  if (pickerTitle) pickerTitle.textContent = title;
  if (swatchGrid && swatchGrid.childElementCount === 0) {
    PALETTE.forEach((hex) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = hex;
      b.setAttribute("data-hex", hex);
      swatchGrid.appendChild(b);
    });
  }
  pickerDialog.dataset.target = target;
  if (typeof pickerDialog.showModal === "function") {
    pickerDialog.style.opacity = "0";
    if (pickerBackdrop) pickerBackdrop.classList.add("active");
    pickerDialog.showModal();
    pickerDialog.animate([
      { transform: "translate(-50%, 40px)", opacity: 0 },
      { transform: "translate(-50%, 0px)", opacity: 1 }
    ], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
  }
}
function closePicker() {
  if (!pickerDialog.open) return;
  const anim = pickerDialog.animate([
    { transform: "translate(-50%, 0px)", opacity: 1 },
    { transform: "translate(-50%, 40px)", opacity: 0 }
  ], { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
  anim.onfinish = () => { pickerDialog.close(); if (pickerBackdrop) pickerBackdrop.classList.remove("active"); };
}
document.getElementById("picker-close").addEventListener("click", closePicker);
if (pickerBackdrop) pickerBackdrop.addEventListener("click", closePicker);
if (swatchGrid) swatchGrid.addEventListener("click", (e) => {
  const btn = e.target.closest(".swatch");
  if (!btn) return;
  const hex = btn.getAttribute("data-hex");
  const target = pickerDialog.dataset.target;
  if (target === "dice") {
    settingsForm.diceColor.value = hex;
    appState.diceColor = hex;
    const dot = document.querySelector('#dice-color-chip .dot');
    if (dot) dot.style.background = hex;
  } else if (target === "pip") {
    settingsForm.pipColor.value = hex;
    appState.pipColor = hex;
    const dot = document.querySelector('#pip-color-chip .dot');
    if (dot) dot.style.background = hex;
  } else if (target === "bg") {
    settingsForm.background.value = hex;
    appState.background = hex;
    const dot = document.querySelector('#bg-color-chip .dot');
    if (dot) dot.style.background = hex;
    scene.background = new THREE.Color(appState.background);
  } else if (target === 'bg-start') {
    appState.bgStart = hex;
    const dot = document.querySelector('#bg-start-chip .dot'); if (dot) dot.style.background = hex;
    applyBackground();
  } else if (target === 'bg-end') {
    appState.bgEnd = hex;
    const dot = document.querySelector('#bg-end-chip .dot'); if (dot) dot.style.background = hex;
    applyBackground();
  }
  rebuildDice();
  closePicker();
});

// Bind chip clicks
document.getElementById("dice-color-chip").addEventListener("click", () => openPicker("dice"));
document.getElementById("pip-color-chip").addEventListener("click", () => openPicker("pip"));
document.getElementById("bg-color-chip").addEventListener("click", () => openPicker("bg"));
const bgStartChip = document.getElementById('bg-start-chip'); if (bgStartChip) bgStartChip.addEventListener('click', ()=> openPicker('bg-start'));
const bgEndChip = document.getElementById('bg-end-chip'); if (bgEndChip) bgEndChip.addEventListener('click', ()=> openPicker('bg-end'));

// Live preview interactions
const numRange = document.getElementById("num-dice-range");
if (numRange) {
  numRange.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    settingsForm.numDice.value = String(v);
    appState.numDice = Math.max(1, Math.min(10, v));
    rebuildDice();
  });
}
settingsForm.numDice.addEventListener("input", (e) => {
  const v = parseInt(e.target.value || "2", 10);
  appState.numDice = Math.max(1, Math.min(10, v));
  if (numDiceDisplay) numDiceDisplay.textContent = String(appState.numDice);
  rebuildDice();
});

if (stepperDec) stepperDec.addEventListener("click", () => {
  const v = Math.max(1, (parseInt(settingsForm.numDice.value || "2", 10) - 1));
  settingsForm.numDice.value = String(v);
  appState.numDice = v;
  const countLabel = document.getElementById("count-label");
  if (countLabel) countLabel.textContent = String(v);
  if (numDiceDisplay) numDiceDisplay.textContent = String(v);
  rebuildDice();
});
if (stepperInc) stepperInc.addEventListener("click", () => {
  const v = Math.min(10, (parseInt(settingsForm.numDice.value || "2", 10) + 1));
  settingsForm.numDice.value = String(v);
  appState.numDice = v;
  const countLabel = document.getElementById("count-label");
  if (countLabel) countLabel.textContent = String(v);
  if (numDiceDisplay) numDiceDisplay.textContent = String(v);
  rebuildDice();
});

settingsForm.diceColor.addEventListener("input", (e) => {
  appState.diceColor = e.target.value || "#ffffff";
  rebuildDice();
});
settingsForm.pipColor.addEventListener("input", (e) => {
  appState.pipColor = e.target.value || "#000000";
  rebuildDice();
});
settingsForm.background.addEventListener("input", (e) => {
  appState.background = e.target.value || "#0e0e0e";
  scene.background = new THREE.Color(appState.background);
});

// Edge radius controls removed; radius is fixed

// Reset
const resetBtn = document.getElementById("reset-settings");
if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    appState.numDice = 2;
    appState.diceColor = "#ffffff";
    appState.pipColor = "#000000";
    appState.background = "#0e0e0e";
    settingsForm.numDice.value = "2";
    if (numRange) numRange.value = "2";
    settingsForm.diceColor.value = appState.diceColor;
    settingsForm.pipColor.value = appState.pipColor;
    settingsForm.background.value = appState.background;
    scene.background = new THREE.Color(appState.background);
    rebuildDice();
  });
}

// Preset chips
const chips = document.getElementById("preset-chips");
if (chips) {
  chips.addEventListener("click", (e) => {
    const target = e.target.closest(".chip");
    if (!target) return;
    const diceColor = target.getAttribute("data-dice-color");
    const pipColor = target.getAttribute("data-pip-color");
    const background = target.getAttribute("data-background");
    if (diceColor) settingsForm.diceColor.value = diceColor;
    if (pipColor) settingsForm.pipColor.value = pipColor;
    if (background) settingsForm.background.value = background;
    appState.diceColor = settingsForm.diceColor.value;
    appState.pipColor = settingsForm.pipColor.value;
    appState.background = settingsForm.background.value;
    const dDot = document.querySelector('#dice-color-chip .dot'); if (dDot) dDot.style.background = appState.diceColor;
    const pDot = document.querySelector('#pip-color-chip .dot'); if (pDot) pDot.style.background = appState.pipColor;
    const bDot = document.querySelector('#bg-color-chip .dot'); if (bDot) bDot.style.background = appState.background;
    scene.background = new THREE.Color(appState.background);
    rebuildDice();
  });
}

// Roll style segmented control handlers
const rollStyle = document.getElementById("roll-style");
if (rollStyle) {
  rollStyle.addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    rollStyle.querySelectorAll('button').forEach((b)=>b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.getAttribute('data-mode');
    appState.rollMode = mode === 'spin' ? 'spin' : 'physics';
    resetDiceTransformsForMode();
  });
}

// Background mode switching
function showBgMode(mode) {
  if (!bgColorRow || !bgGradientRows || !bgImageRow) return;
  const isColor = mode === 'color';
  const isGradient = mode === 'gradient';
  const isImage = mode === 'image';
  bgColorRow.style.display = isColor ? '' : 'none';
  bgGradientRows.style.display = isGradient ? '' : 'none';
  bgImageRow.style.display = isImage ? '' : 'none';
}
if (bgMode) {
  bgMode.addEventListener('click', (e)=>{
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    bgMode.querySelectorAll('button').forEach((x)=>x.classList.remove('active'));
    b.classList.add('active');
    appState.bgMode = b.getAttribute('data-mode');
    showBgMode(appState.bgMode);
    applyBackground();
  });
}

// Apply background based on current mode
function applyBackground() {
  const mode = appState.bgMode || 'color';
  if (mode === 'color') {
    scene.background = new THREE.Color(appState.background || '#0e0e0e');
  } else if (mode === 'gradient') {
    const start = new THREE.Color(appState.bgStart || '#101010');
    const end = new THREE.Color(appState.bgEnd || '#30180a');
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, `#${start.getHexString()}`);
    grad.addColorStop(1, `#${end.getHexString()}`);
    ctx.fillStyle = grad; ctx.fillRect(0,0,1,size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    scene.background = tex;
  } else if (mode === 'image' && appState.bgImageTexture) {
    scene.background = appState.bgImageTexture;
  }
}

// Image picker
if (bgImageChoose && bgImageInput) {
  bgImageChoose.addEventListener('click', ()=> bgImageInput.click());
  bgImageInput.addEventListener('change', (e)=>{
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const loader = new THREE.TextureLoader();
    loader.load(url, (tex)=>{
      tex.colorSpace = THREE.SRGBColorSpace;
      appState.bgImageTexture = tex;
      applyBackground();
    });
  });
}


