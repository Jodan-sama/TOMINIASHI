// ============================================================
// TOMI NIASHI  /  トミ ニアシ
// Breathing instruments. Every pixel is dynamic.
// ============================================================

import * as THREE from "three";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// -----------------------------------------------------------
// State
// -----------------------------------------------------------
const state = {
  mouse: { x: -9999, y: -9999, nx: 0, ny: 0, vx: 0, vy: 0, px: 0, py: 0 },
  scroll: 0,
  time: 0,
  hovered: null,
  openProduct: null,
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: Math.min(window.devicePixelRatio, 2),
};

// -----------------------------------------------------------
// Product data
// -----------------------------------------------------------
const PRODUCTS = [
  {
    id: 0,
    num: "01",
    name: "NEBULA SPHERE",
    kana: "ネビュラ・スフィア",
    price: "$4,200",
    priceYen: "¥ 620,000",
    desc: "A blown glass icosasphere enclosing roughly 180ml of circulating orange plasma. The plasma pulse is driven by the ambient capacitive field of whoever sits within one metre of the instrument. Slow, soft, continuous drone. Unique per person.",
    specs: [
      ["VESSEL", "BOROSILICATE / Ø 22cm"],
      ["PLASMA", "TN-ORANGE 14 / 180ml"],
      ["OUTPUT", "STEREO 6.3mm / BLUETOOTH"],
      ["WEIGHT", "3.4 kg"],
      ["RANGE", "40 Hz – 12 kHz"],
      ["TUNING", "HAND · PER UNIT"],
    ],
    accent: "#FF4500",
  },
  {
    id: 1,
    num: "02",
    name: "RESONANT PILLAR",
    kana: "レゾナント・ピラー",
    price: "$6,800",
    priceYen: "¥ 980,000",
    desc: "A 1.2-metre column of twisted, fluted glass fed from below by a peristaltic plasma pump. As the orange fluid climbs the twist, contact microphones along the spine pick up its resonant modes and synthesise them in real time.",
    specs: [
      ["HEIGHT", "120 cm"],
      ["PLASMA", "TN-ORANGE 14 / 720ml"],
      ["OUTPUT", "QUAD 6.3mm · MIDI"],
      ["WEIGHT", "14 kg"],
      ["RANGE", "22 Hz – 18 kHz"],
      ["TUNING", "HAND · PER UNIT"],
    ],
    accent: "#FF4500",
  },
  {
    id: 2,
    num: "03",
    name: "ORBITAL FLUX",
    kana: "オービタル・フラックス",
    price: "$3,400",
    priceYen: "¥ 498,000",
    desc: "A hollow glass torus with a single drop of concentrated plasma orbiting inside. The drop's position modulates a self-playing FM voice. Lay on its side, hang from ceiling, or set it spinning — it will generate music until you stop it.",
    specs: [
      ["DIAMETER", "38 cm"],
      ["PLASMA", "TN-ORANGE 19 / 12ml"],
      ["OUTPUT", "STEREO 3.5mm"],
      ["WEIGHT", "1.9 kg"],
      ["RANGE", "60 Hz – 16 kHz"],
      ["TUNING", "HAND · PER UNIT"],
    ],
    accent: "#FF4500",
  },
  {
    id: 3,
    num: "04",
    name: "VERTEBRAE SYNTH",
    kana: "バーテブレ・シンセ",
    price: "$9,200",
    priceYen: "¥ 1,340,000",
    desc: "Seven articulated glass vertebrae, each holding its own plasma nucleus. The spine undulates under servo control, driven by the music it produces. The result is an instrument that dances while it sings. Each vertebra is independently tunable.",
    specs: [
      ["LENGTH", "85 cm (ext.)"],
      ["VERTEBRAE", "7 · MODULAR"],
      ["OUTPUT", "7× MONO · MIDI"],
      ["WEIGHT", "7.1 kg"],
      ["RANGE", "30 Hz – 19 kHz"],
      ["TUNING", "HAND · PER UNIT"],
    ],
    accent: "#FF4500",
  },
];

// -----------------------------------------------------------
// Main renderer & scene
// -----------------------------------------------------------
const sceneCanvas = document.getElementById("scene-canvas");
const renderer = new THREE.WebGLRenderer({
  canvas: sceneCanvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
});
renderer.setPixelRatio(state.dpr);
renderer.setSize(state.width, state.height);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  35,
  state.width / state.height,
  0.1,
  100
);
camera.position.set(0, 0, 10);

// Lights
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(5, 5, 5);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffccaa, 0.5);
fillLight.position.set(-4, 2, 3);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xff5522, 0.4);
rimLight.position.set(0, -5, -2);
scene.add(rimLight);

scene.add(new THREE.AmbientLight(0xffffff, 0.4));

// -----------------------------------------------------------
// Environment map (for reflective 3D text materials).
// PMREM-filtered RoomEnvironment gives soft, studio-like reflections.
// We only apply it to the explicit text materials — product shaders
// are custom GLSL and ignore scene.environment.
// -----------------------------------------------------------
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
const envTexture = pmremGenerator.fromScene(
  new RoomEnvironment(),
  0.04
).texture;
pmremGenerator.dispose();

// Chrome / polished-metal for BREATHING + INSTRUMENTS
const chromeMat = new THREE.MeshPhysicalMaterial({
  color: 0xf2eee6,
  metalness: 1.0,
  roughness: 0.12,
  envMap: envTexture,
  envMapIntensity: 1.7,
  clearcoat: 0.7,
  clearcoatRoughness: 0.08,
});

// Softer ink for FROM (secondary line)
const inkTextMat = new THREE.MeshPhysicalMaterial({
  color: 0x4a4a48,
  metalness: 0.9,
  roughness: 0.28,
  envMap: envTexture,
  envMapIntensity: 1.1,
  clearcoat: 0.4,
});

// Bright orange plasma for LIQUID (+ every other marquee pass)
const orangeTextMat = new THREE.MeshPhysicalMaterial({
  color: 0xff4500,
  metalness: 0.3,
  roughness: 0.18,
  envMap: envTexture,
  envMapIntensity: 1.6,
  clearcoat: 1.0,
  clearcoatRoughness: 0.06,
  emissive: 0xff2200,
  emissiveIntensity: 0.25,
});

// -----------------------------------------------------------
// Background shader (separate canvas, orthographic, fullscreen quad)
// -----------------------------------------------------------
const bgCanvas = document.getElementById("bg-canvas");
const bgRenderer = new THREE.WebGLRenderer({
  canvas: bgCanvas,
  antialias: false,
});
bgRenderer.setPixelRatio(state.dpr);
bgRenderer.setSize(state.width, state.height);

const bgScene = new THREE.Scene();
const bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const bgUniforms = {
  uTime: { value: 0 },
  uRes: { value: new THREE.Vector2(state.width, state.height) },
  uMouse: { value: new THREE.Vector2(0, 0) },
  uScroll: { value: 0 },
};

const bgMaterial = new THREE.ShaderMaterial({
  uniforms: bgUniforms,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime;
    uniform vec2  uRes;
    uniform vec2  uMouse;
    uniform float uScroll;

    // -------------------------------------------------------
    // Hash / noise
    // -------------------------------------------------------
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)),
               dot(p, vec2(269.5, 183.3)));
      return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(dot(hash2(i + vec2(0,0)), f - vec2(0,0)),
            dot(hash2(i + vec2(1,0)), f - vec2(1,0)), u.x),
        mix(dot(hash2(i + vec2(0,1)), f - vec2(0,1)),
            dot(hash2(i + vec2(1,1)), f - vec2(1,1)), u.x),
        u.y);
    }

    // -------------------------------------------------------
    // Line grid — warps toward mouse, breathes with time
    // -------------------------------------------------------
    float gridLines(vec2 uv, float scale, float width) {
      vec2 g = fract(uv * scale) - 0.5;
      float d = min(abs(g.x), abs(g.y));
      return 1.0 - smoothstep(0.0, width, d);
    }

    void main() {
      vec2 uv = vUv;
      float aspect = uRes.x / uRes.y;
      vec2 auv = uv;
      auv.x *= aspect;

      vec2 m = uMouse;
      m.x *= aspect;

      // Mouse-based radial pull
      vec2 toMouse = m - auv;
      float dMouse = length(toMouse);
      float pull = smoothstep(0.8, 0.0, dMouse) * 0.035;
      auv += normalize(toMouse + 1e-5) * pull;

      // Slow flow field to warp UV for lines
      float n1 = noise(auv * 1.2 + uTime * 0.05);
      float n2 = noise(auv * 1.2 - uTime * 0.04 + 13.0);
      vec2 warp = vec2(n1, n2) * 0.08;
      vec2 lineUv = auv + warp;
      lineUv.y += uScroll * 0.00025;

      // Two line scales layered
      float gridA = gridLines(lineUv, 28.0, 0.012);
      float gridB = gridLines(lineUv + 0.25, 7.0,  0.004);

      // Fine horizontal scan lines
      float scan = 0.5 + 0.5 * sin(uv.y * uRes.y * 0.7 + uTime * 1.5);
      scan = pow(scan, 40.0);

      // Noise flicker
      float flk = noise(uv * 800.0 + uTime * 80.0) * 0.04;

      // Base tone — warm bone
      vec3 base = vec3(0.925, 0.918, 0.894);
      // Slight vertical gradient
      base -= vec3(0.02) * uv.y;

      // Dark grey line colour
      vec3 lineCol = vec3(0.07, 0.07, 0.07);

      // Ink the lines in
      vec3 col = mix(base, lineCol, gridA * 0.55);
      col     = mix(col,  lineCol, gridB * 0.22);

      // Mouse bleed — subtle orange glow
      float bleed = smoothstep(0.5, 0.0, dMouse);
      col = mix(col, vec3(1.0, 0.27, 0.0), bleed * 0.08);

      // Bright orange hot dot right at cursor
      float hot = smoothstep(0.04, 0.0, dMouse);
      col = mix(col, vec3(1.0, 0.42, 0.12), hot * 0.35);

      // Scan line
      col -= vec3(0.04) * scan;

      // Noise grain
      col += vec3(flk);

      // Vignette
      vec2 vv = uv - 0.5;
      float vig = 1.0 - dot(vv, vv) * 0.6;
      col *= vig;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial);
bgScene.add(bgQuad);

// -----------------------------------------------------------
// Shared noise GLSL for reuse
// -----------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
  vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }
`;

// -----------------------------------------------------------
// Glass shader (shared constructor)
// -----------------------------------------------------------
function makeGlassMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uHover: { value: 0 },
      uMouse: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec3 vObjPos;
      uniform float uTime;

      ${GLSL_NOISE}

      void main() {
        vec3 p = position;
        // Breathe the glass itself
        float br = snoise(position * 1.5 + uTime * 0.3) * 0.02;
        p += normal * br;

        vObjPos = p;
        vNormal = normalize(normalMatrix * normal);
        vec4 mvp = modelViewMatrix * vec4(p, 1.0);
        vViewPos = mvp.xyz;
        vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * mvp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec3 vObjPos;
      uniform float uTime;
      uniform float uHover;
      uniform vec2  uMouse;

      ${GLSL_NOISE}

      void main() {
        vec3 V = normalize(-vViewPos);
        float fres = pow(1.0 - max(dot(vNormal, V), 0.0), 2.2);

        // Base glass tint — cool, almost white
        vec3 body  = vec3(0.86, 0.87, 0.88);
        vec3 rim   = vec3(1.00, 0.98, 0.95);
        vec3 deep  = vec3(0.55, 0.57, 0.60);

        // Internal refraction fake: sample a noise in object space
        float n = snoise(vObjPos * 2.0 + uTime * 0.2);
        body += n * 0.05;

        // Orange bleed from within when hovered
        vec3 orange = vec3(1.0, 0.33, 0.05);
        body = mix(body, orange, uHover * 0.35 * (0.5 + 0.5 * n));

        vec3 col = mix(deep, body, 0.5 + 0.5 * dot(vNormal, vec3(0.3, 0.9, 0.2)));
        col = mix(col, rim, fres);

        // Specular hot spot on rim
        col += vec3(1.0) * pow(fres, 8.0) * 0.6;

        // Frosted feel: reduce saturation slightly
        col = mix(col, vec3(dot(col, vec3(0.33))), 0.15);

        // Alpha: more opaque at rim, translucent in middle
        float alpha = 0.18 + fres * 0.72 + uHover * 0.1;

        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

// -----------------------------------------------------------
// Liquid shader (orange plasma)
// -----------------------------------------------------------
function makeLiquidMaterial() {
  return new THREE.ShaderMaterial({
    transparent: false,
    uniforms: {
      uTime: { value: 0 },
      uHover: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vNormal;
      uniform float uTime;

      ${GLSL_NOISE}

      void main() {
        vec3 p = position;
        // Undulate
        float n = snoise(position * 2.0 + uTime * 0.6);
        p += normal * n * 0.06;
        vPos = p;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vPos;
      varying vec3 vNormal;
      uniform float uTime;
      uniform float uHover;

      ${GLSL_NOISE}

      void main() {
        // Flowing banding
        float n1 = snoise(vPos * 3.0 + vec3(uTime * 0.3, 0.0, 0.0));
        float n2 = snoise(vPos * 8.0 - vec3(0.0, uTime * 0.4, 0.0));
        float n  = n1 * 0.7 + n2 * 0.3;

        vec3 deep  = vec3(0.78, 0.14, 0.00); // burnt orange
        vec3 mid   = vec3(1.00, 0.27, 0.00); // deep orange
        vec3 hot   = vec3(1.00, 0.55, 0.12); // bright orange
        vec3 glow  = vec3(1.00, 0.82, 0.40); // almost-yellow highlight

        vec3 col = mix(deep, mid, smoothstep(-0.6, 0.2, n));
        col     = mix(col,  hot,  smoothstep(0.1, 0.6, n));
        col     = mix(col,  glow, smoothstep(0.5, 0.9, n1 * n2));

        // Rim glow
        float rim = pow(1.0 - max(dot(normalize(vNormal), vec3(0,0,1)), 0.0), 1.5);
        col += vec3(1.0, 0.5, 0.2) * rim * 0.25;

        // Hover boost
        col = mix(col, glow, uHover * 0.15);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// -----------------------------------------------------------
// Wireframe line accents
// -----------------------------------------------------------
function makeLineMaterial(opacity = 0.7) {
  return new THREE.LineBasicMaterial({
    color: 0x1a1a1a,
    transparent: true,
    opacity,
  });
}

// -----------------------------------------------------------
// Product geometries
// -----------------------------------------------------------
function createOrb() {
  const group = new THREE.Group();
  group.userData.kind = "orb";

  // Outer glass
  const outerGeom = new THREE.IcosahedronGeometry(1.0, 4);
  const outer = new THREE.Mesh(outerGeom, makeGlassMaterial());
  outer.userData.isGlass = true;
  group.add(outer);

  // Inner liquid
  const innerGeom = new THREE.IcosahedronGeometry(0.62, 4);
  const inner = new THREE.Mesh(innerGeom, makeLiquidMaterial());
  inner.userData.isLiquid = true;
  group.add(inner);

  // Wire rings
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.15 + i * 0.05, 0.003, 8, 96),
      makeLineMaterial(0.6 - i * 0.15)
    );
    ring.rotation.x = Math.random() * Math.PI;
    ring.rotation.y = Math.random() * Math.PI;
    ring.userData.orbit = { ax: Math.random() - 0.5, ay: Math.random() - 0.5 };
    group.add(ring);
  }

  // Tiny orbiting sphere
  const bead = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff4500 })
  );
  bead.userData.isBead = true;
  group.add(bead);

  group.userData.hitMesh = outer;
  return group;
}

function createPillar() {
  const group = new THREE.Group();
  group.userData.kind = "pillar";

  // Outer: Lathe swept profile, twisted
  const points = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const y = (t - 0.5) * 2.8;
    const r = 0.38 + 0.15 * Math.sin(t * Math.PI * 2.5) + 0.08 * Math.sin(t * Math.PI * 6);
    points.push(new THREE.Vector2(r, y));
  }
  const latheGeom = new THREE.LatheGeometry(points, 96);

  // Twist vertices
  const pos = latheGeom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const angle = y * 0.6;
    const nx = x * Math.cos(angle) - z * Math.sin(angle);
    const nz = x * Math.sin(angle) + z * Math.cos(angle);
    pos.setXYZ(i, nx, y, nz);
  }
  latheGeom.computeVertexNormals();

  const outer = new THREE.Mesh(latheGeom, makeGlassMaterial());
  outer.userData.isGlass = true;
  group.add(outer);

  // Inner: thin liquid column
  const innerGeom = new THREE.CylinderGeometry(0.18, 0.18, 2.6, 48, 16);
  const innerPos = innerGeom.attributes.position;
  for (let i = 0; i < innerPos.count; i++) {
    const x = innerPos.getX(i);
    const y = innerPos.getY(i);
    const z = innerPos.getZ(i);
    const bulge = Math.sin(y * 2.0) * 0.05;
    const angle = y * 0.8;
    const len = Math.hypot(x, z) + bulge;
    const nx = Math.cos(Math.atan2(z, x) + angle) * len;
    const nz = Math.sin(Math.atan2(z, x) + angle) * len;
    innerPos.setXYZ(i, nx, y, nz);
  }
  innerGeom.computeVertexNormals();

  const inner = new THREE.Mesh(innerGeom, makeLiquidMaterial());
  inner.userData.isLiquid = true;
  group.add(inner);

  // Cap rings
  for (let cy = -1.4; cy <= 1.4; cy += 0.35) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.004, 6, 96),
      makeLineMaterial(0.35)
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = cy;
    group.add(ring);
  }

  group.scale.set(0.8, 0.8, 0.8);
  group.userData.hitMesh = outer;
  return group;
}

function createRing() {
  const group = new THREE.Group();
  group.userData.kind = "ring";

  const outerGeom = new THREE.TorusGeometry(1.0, 0.22, 32, 128);
  const outer = new THREE.Mesh(outerGeom, makeGlassMaterial());
  outer.userData.isGlass = true;
  group.add(outer);

  // Inner liquid torus
  const innerGeom = new THREE.TorusGeometry(1.0, 0.14, 24, 128);
  const inner = new THREE.Mesh(innerGeom, makeLiquidMaterial());
  inner.userData.isLiquid = true;
  group.add(inner);

  // Orbiting drop
  const drop = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 24, 24),
    makeLiquidMaterial()
  );
  drop.userData.isOrbit = true;
  group.add(drop);

  // Outer wire ring
  const wire = new THREE.Mesh(
    new THREE.TorusGeometry(1.35, 0.003, 8, 128),
    makeLineMaterial(0.4)
  );
  group.add(wire);

  group.userData.hitMesh = outer;
  return group;
}

function createSpine() {
  const group = new THREE.Group();
  group.userData.kind = "spine";

  const segments = [];
  const SEG_COUNT = 7;
  for (let i = 0; i < SEG_COUNT; i++) {
    const segGroup = new THREE.Group();

    // Vertebra shell
    const r = 0.32 - i * 0.018;
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(r, 32, 24),
      makeGlassMaterial()
    );
    shell.userData.isGlass = true;
    shell.scale.set(1.0, 0.75, 1.0);
    segGroup.add(shell);

    // Plasma core
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.55, 24, 16),
      makeLiquidMaterial()
    );
    core.userData.isLiquid = true;
    segGroup.add(core);

    // Connecting thin line to next
    if (i < SEG_COUNT - 1) {
      const lineGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.38, 0, 0),
      ]);
      const connector = new THREE.Line(lineGeom, makeLineMaterial(0.5));
      segGroup.add(connector);
    }

    segments.push(segGroup);
    group.add(segGroup);
  }
  group.userData.segments = segments;
  group.userData.hitMesh = segments[Math.floor(SEG_COUNT / 2)].children[0];
  return group;
}

// -----------------------------------------------------------
// Instantiate products + layout
// -----------------------------------------------------------
const productBuilders = [createOrb, createPillar, createRing, createSpine];
const products = productBuilders.map((fn, i) => {
  const obj = fn();
  obj.userData.id = i;
  obj.userData.data = PRODUCTS[i];
  obj.userData.seed = Math.random() * 100;
  scene.add(obj);
  return obj;
});

// Layout: 4 products in view, not perfectly symmetric
// Positions in world coords (camera at z=10, fov=35 means visible ~3.15 units at z=0)
const layouts = [
  { pos: [ 2.6,  1.3, -0.5], scale: 1.0 },   // ORB — upper right
  { pos: [-2.8, -0.5, -1.2], scale: 1.2 },   // PILLAR — left (tall)
  { pos: [ 1.7, -1.6,  0.6], scale: 0.95 },  // RING — lower right
  { pos: [-0.9,  1.5,  0.3], scale: 1.0 },   // SPINE — upper left
];
products.forEach((p, i) => {
  p.position.set(...layouts[i].pos);
  p.scale.multiplyScalar(layouts[i].scale);
  // Random-ish orientation
  p.rotation.set(
    Math.random() * 0.5,
    Math.random() * Math.PI * 2,
    Math.random() * 0.3
  );
});

// -----------------------------------------------------------
// 3D HERO TITLE + 3D MARQUEE
// Real extruded geometry with reflective PBR material.
// Per-character meshes so each letter inflates / rotates / wobbles
// independently with cursor proximity.
// -----------------------------------------------------------
const text3D = {
  font: null,
  hero: null, // THREE.Group
  heroChars: [], // [{ mesh, seed, rotSeed, lineIndex }]
  heroLines: [], // per-line group for resize layout
  heroBaseY: 2.0, // world-Y of hero center at scroll=0
  marquee: null, // THREE.Group
  marqueeChars: [],
  marqueeLoopWidth: 0, // width of one phrase copy
  marqueeBaseY: -2.85, // pinned bottom of viewport
  ready: false,
};

// Some geometry helpers
const _v3 = new THREE.Vector3();
const _box = new THREE.Box3();

function buildCharMesh(ch, material, size, italic = 0) {
  // Nearly-flat balloon letter: a thin puffed shape, not a deep prism.
  // Depth is intentionally tiny so edges never dominate the view, bevel
  // is just enough to catch a highlight.
  const geom = new TextGeometry(ch, {
    font: text3D.font,
    size,
    depth: size * 0.015,
    curveSegments: 8,
    bevelEnabled: true,
    bevelThickness: size * 0.012,
    bevelSize: size * 0.014,
    bevelOffset: 0,
    bevelSegments: 4,
  });
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const width = (bb.max.x - bb.min.x) || size * 0.3;
  // Center the geometry horizontally at origin of mesh (keep baseline at y=0)
  const offsetX = -(bb.max.x + bb.min.x) / 2;
  const offsetY = -(bb.max.y + bb.min.y) / 2;
  geom.translate(offsetX, offsetY, 0);
  const mesh = new THREE.Mesh(geom, material);
  if (italic) mesh.rotation.z = -italic;
  mesh.userData.width = width;
  return mesh;
}

function buildHero3D() {
  const group = new THREE.Group();
  text3D.hero = group;
  scene.add(group);

  const lines = [
    { text: "BREATHING", material: chromeMat, size: 0.42, italic: 0 },
    { text: "INSTRUMENTS", material: chromeMat, size: 0.42, italic: 0 },
    { text: "FROM", material: inkTextMat, size: 0.30, italic: 0 },
    { text: "LIQUID", material: orangeTextMat, size: 0.46, italic: 0.06 },
  ];

  const lineGap = 0.06; // vertical gap between lines
  const charGap = 0.04; // tracking between chars

  let yCursor = 0;

  lines.forEach((line, li) => {
    const lineGroup = new THREE.Group();
    // Pre-build all chars in this line
    const meshes = [];
    let totalW = 0;
    for (const ch of line.text) {
      if (ch === " ") {
        meshes.push({ space: true, width: line.size * 0.55 });
        totalW += line.size * 0.55;
      } else {
        const mesh = buildCharMesh(ch, line.material, line.size, line.italic);
        meshes.push({ mesh, width: mesh.userData.width });
        totalW += mesh.userData.width;
      }
    }
    totalW += (meshes.length - 1) * charGap;

    // Lay out centered
    let px = -totalW / 2;
    meshes.forEach((m, ci) => {
      if (!m.space) {
        m.mesh.position.x = px + m.width / 2;
        m.mesh.position.y = 0;
        lineGroup.add(m.mesh);
        text3D.heroChars.push({
          mesh: m.mesh,
          seed: Math.random() * 1000,
          rotSeed: (Math.random() - 0.5) * 2,
          lineIndex: li,
          italicBase: line.italic ? -line.italic : 0,
        });
      }
      px += m.width + charGap;
    });

    lineGroup.position.y = yCursor;
    yCursor -= line.size * 1.05 + lineGap;
    text3D.heroLines.push({ group: lineGroup, size: line.size });
    group.add(lineGroup);
  });

  // Recenter group vertically around its bbox
  _box.setFromObject(group);
  const centerY = (_box.max.y + _box.min.y) / 2;
  group.children.forEach((lg) => (lg.position.y -= centerY));

  layoutHero3D();
}

function layoutHero3D() {
  if (!text3D.hero) return;
  // Compact. Target ~32% viewport width / ~36% height so the title stays
  // up in its own area and never crowds the rest of the page.
  const vh = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
  const vw = vh * camera.aspect;
  text3D.hero.scale.setScalar(1);
  // Neutral rotation during measure so bbox reflects true extents.
  text3D.hero.rotation.set(0, 0, 0);
  _box.setFromObject(text3D.hero);
  const natW = _box.max.x - _box.min.x;
  const natH = _box.max.y - _box.min.y;
  const sw = (vw * 0.32) / natW;
  const sh = (vh * 0.36) / natH;
  const s = Math.min(sw, sh);
  text3D.hero.scale.setScalar(s);
  // Sit in upper-third of viewport like a title, not dead center.
  text3D.hero.position.set(0, vh * 0.12, 0.2);
  text3D.heroBaseY = vh * 0.12;
}

function buildMarquee3D() {
  const group = new THREE.Group();
  text3D.marquee = group;
  scene.add(group);

  const phrase = "BREATHING · INSTRUMENTS · FROM · LIQUID · ";
  const repeats = 6;
  const size = 0.32;
  const charGap = 0.035;

  // Build one pass so we know its width, then replicate
  const passWidth = (() => {
    let sum = 0;
    for (const ch of phrase) {
      if (ch === " ") sum += size * 0.55;
      else {
        // Approximate width from a sample mesh (build & discard)
        const tmp = buildCharMesh(ch, chromeMat, size, 0);
        sum += tmp.userData.width + charGap;
        tmp.geometry.dispose();
      }
    }
    return sum;
  })();

  let px = 0;
  for (let r = 0; r < repeats; r++) {
    const italic = r % 2 === 1 ? 0.08 : 0;
    const mat = r % 2 === 1 ? orangeTextMat : chromeMat;
    for (const ch of phrase) {
      if (ch === " ") {
        px += size * 0.55;
        continue;
      }
      const mesh = buildCharMesh(ch, mat, size, italic);
      mesh.position.x = px + mesh.userData.width / 2;
      group.add(mesh);
      text3D.marqueeChars.push({
        mesh,
        seed: Math.random() * 1000,
        rotSeed: (Math.random() - 0.5) * 2,
        italicBase: -italic,
      });
      px += mesh.userData.width + charGap;
    }
  }
  text3D.marqueeLoopWidth = passWidth;

  layoutMarquee3D();
}

function layoutMarquee3D() {
  if (!text3D.marquee) return;
  const vh = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
  // Pin near bottom of viewport (world-Y), slightly off the edge
  text3D.marqueeBaseY = -vh * 0.42;
  text3D.marquee.position.y = text3D.marqueeBaseY;
  text3D.marquee.position.z = 0.0;
}

// ---- 3D WebGL text is DISABLED. Perspective foreshortening on extruded
// letters kept letting their geometry fill the viewport at certain cursor
// positions, obscuring everything else. We render the hero title + marquee
// as HTML with CSS chrome / balloon styling instead (see style.css).
// The builder / layout / updater functions above are kept but dormant.
// -----------------------------------------------------------
// (Intentionally no fontLoader.load() call — text3D.ready stays false,
// updateText3D() early-returns, buildHero3D()/buildMarquee3D() never fire.)

// ---- Per-frame update: per-char proximity inflate + marquee scroll ----
const _tmpNdc = new THREE.Vector3();
function updateText3D(t) {
  if (!text3D.ready) return;

  const mx = state.mouse.x;
  const my = state.mouse.y;
  const W = state.width;
  const H = state.height;
  // Tighter influence radius so only nearby letters puff up
  const R = 180;
  const R2 = R * R;

  // --- Hero: scroll-sync + per-char gentle bubble pulse ---
  if (text3D.hero) {
    // Move hero up as user scrolls, so it feels tied to the hero section.
    const vh = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
    const worldPerPx = vh / H;
    text3D.hero.position.y =
      text3D.heroBaseY + state.scroll * worldPerPx * 1.1;
    // No group-level tilt — keeping the text face-on guarantees we never see
    // its sides, which would otherwise look like long dark bars.
    text3D.hero.rotation.set(0, 0, 0);

    for (let i = 0; i < text3D.heroChars.length; i++) {
      const c = text3D.heroChars[i];
      // Project char position to screen
      c.mesh.updateWorldMatrix(true, false);
      _tmpNdc.setFromMatrixPosition(c.mesh.matrixWorld);
      _tmpNdc.project(camera);
      const sx = (_tmpNdc.x * 0.5 + 0.5) * W;
      const sy = (-_tmpNdc.y * 0.5 + 0.5) * H;

      const dx = mx - sx;
      const dy = my - sy;
      const d2 = dx * dx + dy * dy;

      let s = 0;
      if (d2 < R2) s = 1 - Math.sqrt(d2) / R;
      const ss = s * s;

      // Gentle ambient breathing + small pop-on-hover — max ~1.22x
      const amb = Math.sin(t * 1.6 + c.seed) * 0.02;
      const scale = 1 + amb + ss * 0.2;
      c.mesh.scale.setScalar(scale);

      // Keep letters face-on: only Z rotation (italic + tiny wobble), no X/Y
      // which would expose their extruded sides.
      const rz = c.italicBase + Math.sin(t * 2.5 + c.seed) * ss * 0.04;
      c.mesh.rotation.set(0, 0, rz);
    }
  }

  // --- Marquee: translate loop + per-char gentle bubble pulse ---
  if (text3D.marquee) {
    const speed = 0.22; // world units/sec — calmer ribbon
    const x = -((t * speed) % text3D.marqueeLoopWidth);
    // Scale the ribbon so letters are ~3.5% of viewport height — a thin strip
    const vh = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
    const targetWorldH = vh * 0.035;
    const natH = 0.32; // buildCharMesh size for marquee
    const sc = targetWorldH / natH;
    text3D.marquee.scale.setScalar(sc);
    text3D.marquee.position.x = x * sc;
    text3D.marquee.position.y = text3D.marqueeBaseY;

    for (let i = 0; i < text3D.marqueeChars.length; i++) {
      const c = text3D.marqueeChars[i];
      c.mesh.updateWorldMatrix(true, false);
      _tmpNdc.setFromMatrixPosition(c.mesh.matrixWorld);
      _tmpNdc.project(camera);
      const sx = (_tmpNdc.x * 0.5 + 0.5) * W;
      const sy = (-_tmpNdc.y * 0.5 + 0.5) * H;

      const dx = mx - sx;
      const dy = my - sy;
      const d2 = dx * dx + dy * dy;

      let s = 0;
      if (d2 < R2) s = 1 - Math.sqrt(d2) / R;
      const ss = s * s;

      const amb = Math.sin(t * 2.0 + c.seed) * 0.015;
      const scale = 1 + amb + ss * 0.2;
      c.mesh.scale.setScalar(scale);

      // Same face-on policy as the hero — only Z rotation.
      const rz = c.italicBase + Math.sin(t * 3.0 + c.seed) * ss * 0.04;
      c.mesh.rotation.set(0, 0, rz);
    }
  }
}

// -----------------------------------------------------------
// Raycasting for interactions
// -----------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pickProduct() {
  ndc.x = (state.mouse.x / state.width) * 2 - 1;
  ndc.y = -(state.mouse.y / state.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  // Gather all hit meshes
  const hitMeshes = products.map((p) => p.userData.hitMesh).filter(Boolean);
  const hits = raycaster.intersectObjects(hitMeshes, false);
  if (hits.length === 0) return null;
  // Find which product this mesh belongs to
  const picked = hits[0].object;
  for (const p of products) {
    if (p.userData.hitMesh === picked) return p;
    // Check children too
    let found = false;
    p.traverse((c) => { if (c === picked) found = true; });
    if (found) return p;
  }
  return null;
}

// -----------------------------------------------------------
// Grain overlay (regenerated every ~4 frames)
// -----------------------------------------------------------
const grainCanvas = document.getElementById("grain-canvas");
const grainCtx = grainCanvas.getContext("2d");
function resizeGrain() {
  grainCanvas.width = Math.floor(state.width / 2);
  grainCanvas.height = Math.floor(state.height / 2);
  grainCanvas.style.width = state.width + "px";
  grainCanvas.style.height = state.height + "px";
}
resizeGrain();
function drawGrain() {
  const w = grainCanvas.width;
  const h = grainCanvas.height;
  const img = grainCtx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 200 + ((Math.random() * 55) | 0);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 60;
  }
  grainCtx.putImageData(img, 0, 0);
}

// -----------------------------------------------------------
// Mouse & scroll
// -----------------------------------------------------------
window.addEventListener("mousemove", (e) => {
  state.mouse.px = state.mouse.x;
  state.mouse.py = state.mouse.y;
  state.mouse.x = e.clientX;
  state.mouse.y = e.clientY;
  state.mouse.nx = (e.clientX / state.width) * 2 - 1;
  state.mouse.ny = -(e.clientY / state.height) * 2 + 1;
});

window.addEventListener("scroll", () => {
  state.scroll = window.scrollY;
  bgUniforms.uScroll.value = state.scroll;
});

window.addEventListener("resize", () => {
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  renderer.setSize(state.width, state.height);
  bgRenderer.setSize(state.width, state.height);
  camera.aspect = state.width / state.height;
  camera.updateProjectionMatrix();
  bgUniforms.uRes.value.set(state.width, state.height);
  resizeGrain();
  // Keep 3D text fitted to the new viewport
  if (text3D.ready) {
    layoutHero3D();
    layoutMarquee3D();
  }
});

// -----------------------------------------------------------
// Click on canvas → raycast → open modal
// -----------------------------------------------------------
sceneCanvas.addEventListener("click", (e) => {
  state.mouse.x = e.clientX;
  state.mouse.y = e.clientY;
  const picked = pickProduct();
  if (picked) openProductModal(picked.userData.data);
});

// -----------------------------------------------------------
// HUD labels track 3D product positions
// -----------------------------------------------------------
const labelEls = Array.from(document.querySelectorAll(".product-label"));
const tmpVec = new THREE.Vector3();
function updateLabels() {
  const productsSection = document.getElementById("instruments");
  const rect = productsSection.getBoundingClientRect();
  const sectionVisible = rect.top < state.height * 0.9 && rect.bottom > 0;

  products.forEach((p, i) => {
    const el = labelEls[i];
    if (!el) return;
    p.updateWorldMatrix(true, false);
    tmpVec.setFromMatrixPosition(p.matrixWorld);
    tmpVec.project(camera);
    const x = (tmpVec.x * 0.5 + 0.5) * state.width;
    const y = (-tmpVec.y * 0.5 + 0.5) * state.height;

    // Offset so label doesn't overlap object
    const offsetX = x > state.width * 0.5 ? 60 : -260;
    const offsetY = -20;

    el.style.transform = `translate(${x + offsetX}px, ${y + offsetY}px)`;

    if (sectionVisible) el.classList.add("visible");
    else el.classList.remove("visible");
  });
}

labelEls.forEach((el, i) => {
  const btn = el.querySelector(".plabel-open");
  btn.addEventListener("click", () => openProductModal(PRODUCTS[i]));
  el.addEventListener("mouseenter", () => {
    products[i].userData.hovered = true;
  });
  el.addEventListener("mouseleave", () => {
    products[i].userData.hovered = false;
  });
});

// -----------------------------------------------------------
// Modal (product detail)
// -----------------------------------------------------------
const modalEl = document.getElementById("modal");
const modalInner = document.getElementById("modal-inner");
const modalClose = document.getElementById("modal-close");

let modalRenderer = null;
let modalScene = null;
let modalCamera = null;
let modalProduct = null;
let modalAnimId = null;

function openProductModal(data) {
  state.openProduct = data.id;
  modalInner.innerHTML = `
    <div class="modal-visual">
      <canvas id="modal-canvas"></canvas>
    </div>
    <div class="modal-details">
      <div class="md-num mono">// ${data.num}  ·  ${data.kana}</div>
      <h2 class="md-name">
        ${data.name}
        <div class="md-name-kana">${data.kana}</div>
      </h2>
      <div class="md-desc">${data.desc}</div>
      <div class="md-specs">
        ${data.specs
          .map(
            ([k, v]) => `
          <div class="md-spec-label mono">${k}</div>
          <div class="md-spec-value mono">${v}</div>
        `
          )
          .join("")}
      </div>
      <div class="md-price-row">
        <div>
          <div class="md-price-label mono">PRICE · ATELIER DIRECT</div>
          <div class="md-price">${data.price}</div>
          <div class="md-price-sub mono">${data.priceYen} · EX WORKS TOKYO</div>
        </div>
      </div>
      <button class="md-buy"><span>RESERVE INSTRUMENT ⟶</span></button>
    </div>
  `;
  modalEl.classList.add("open");
  modalEl.setAttribute("aria-hidden", "false");

  // Setup modal 3D preview
  const mcanvas = document.getElementById("modal-canvas");
  if (modalRenderer) modalRenderer.dispose();
  modalRenderer = new THREE.WebGLRenderer({
    canvas: mcanvas,
    alpha: true,
    antialias: true,
  });
  const mw = mcanvas.clientWidth;
  const mh = mcanvas.clientHeight;
  modalRenderer.setPixelRatio(state.dpr);
  modalRenderer.setSize(mw, mh, false);

  modalScene = new THREE.Scene();
  modalCamera = new THREE.PerspectiveCamera(35, mw / mh, 0.1, 100);
  modalCamera.position.set(0, 0, 6);

  modalScene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const ml1 = new THREE.DirectionalLight(0xffffff, 1.1);
  ml1.position.set(4, 4, 4);
  modalScene.add(ml1);
  const ml2 = new THREE.DirectionalLight(0xff6a2a, 0.5);
  ml2.position.set(-3, 2, 3);
  modalScene.add(ml2);

  // Fresh instance of the product for the modal
  modalProduct = productBuilders[data.id]();
  modalProduct.scale.multiplyScalar(1.6);
  modalScene.add(modalProduct);

  cancelAnimationFrame(modalAnimId);
  const t0 = performance.now();
  function animateModal() {
    const now = performance.now();
    const t = (now - t0) / 1000;
    modalProduct.rotation.y = t * 0.6;
    modalProduct.rotation.x = Math.sin(t * 0.3) * 0.2;
    modalProduct.traverse((o) => {
      if (o.isMesh && o.material && o.material.uniforms) {
        if (o.material.uniforms.uTime) o.material.uniforms.uTime.value = t;
      }
    });
    // Modal product animation (mini clone of main loop motion)
    animateProductLocal(modalProduct, t);
    modalRenderer.render(modalScene, modalCamera);
    modalAnimId = requestAnimationFrame(animateModal);
  }
  animateModal();

  // Wire buy button to just pulse for now
  const buyBtn = modalInner.querySelector(".md-buy");
  buyBtn.addEventListener("click", () => {
    buyBtn.querySelector("span").textContent = "RESERVED — CHECK YOUR EMAIL";
    buyBtn.style.background = "var(--orange)";
    buyBtn.style.borderColor = "var(--orange)";
  });

  // Resize modal canvas when visible
  setTimeout(() => {
    const w = mcanvas.clientWidth;
    const h = mcanvas.clientHeight;
    modalRenderer.setSize(w, h, false);
    modalCamera.aspect = w / h;
    modalCamera.updateProjectionMatrix();
  }, 100);

  // Split modal text into wiggleable chars
  addModalWiggles();
}

function closeModal() {
  modalEl.classList.remove("open");
  modalEl.setAttribute("aria-hidden", "true");
  state.openProduct = null;
  cancelAnimationFrame(modalAnimId);
  if (modalRenderer) {
    modalRenderer.dispose();
    modalRenderer = null;
  }
  // Drop the modal's char registry entries
  wiggleState.chars = wiggleState.chars.filter((c) => !c.modalChar);
}

modalClose.addEventListener("click", closeModal);
modalEl.querySelector(".modal-bg").addEventListener("click", closeModal);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// -----------------------------------------------------------
// Per-product motion
// -----------------------------------------------------------
function animateProductLocal(group, t) {
  const seed = group.userData.seed || 0;

  if (group.userData.kind === "orb") {
    group.rotation.y = t * 0.2 + seed;
    group.rotation.x = Math.sin(t * 0.4 + seed) * 0.15;
    // Rings slowly tumble
    let ringIdx = 0;
    group.children.forEach((c) => {
      if (c.userData.orbit) {
        c.rotation.x += 0.002 * c.userData.orbit.ax;
        c.rotation.y += 0.002 * c.userData.orbit.ay;
        c.rotation.z += 0.001;
        ringIdx++;
      }
      if (c.userData.isBead) {
        const a = t * 0.8 + seed;
        c.position.set(
          Math.cos(a) * 1.2,
          Math.sin(a * 1.3) * 1.1,
          Math.sin(a) * 1.2
        );
      }
    });
  }

  if (group.userData.kind === "pillar") {
    group.rotation.y = t * 0.25 + seed;
    group.position.y = (group.userData.baseY || 0) + Math.sin(t * 0.6 + seed) * 0.08;
  }

  if (group.userData.kind === "ring") {
    group.rotation.x = Math.PI * 0.35 + Math.sin(t * 0.4 + seed) * 0.15;
    group.rotation.z = t * 0.3 + seed;
    // Orbit drop around
    group.children.forEach((c) => {
      if (c.userData.isOrbit) {
        const a = t * 1.5 + seed;
        c.position.set(Math.cos(a) * 1.0, Math.sin(a * 0.6) * 0.2, Math.sin(a) * 1.0);
      }
    });
  }

  if (group.userData.kind === "spine") {
    const segs = group.userData.segments;
    if (segs) {
      segs.forEach((s, i) => {
        const phase = t * 1.2 + i * 0.45 + seed;
        s.position.x = i * 0.42 - (segs.length - 1) * 0.21;
        s.position.y = Math.sin(phase) * 0.18;
        s.position.z = Math.cos(phase * 0.6) * 0.12;
        s.rotation.z = Math.sin(phase) * 0.3;
      });
      group.rotation.y = t * 0.15 + seed;
      group.rotation.z = Math.sin(t * 0.4 + seed) * 0.08;
    }
  }
}

// -----------------------------------------------------------
// Cursor
// -----------------------------------------------------------
const cursorRing = document.getElementById("cursor-ring");
const cursorDot = document.getElementById("cursor-dot");
const cursorLabel = document.getElementById("cursor-label");
const crosshair = document.getElementById("crosshair");
const crosshairH = crosshair.querySelector(".crosshair-h");
const crosshairV = crosshair.querySelector(".crosshair-v");
const crosshairBox = crosshair.querySelector(".crosshair-box");
const crosshairLabel = document.getElementById("crosshair-label");

function updateCursor() {
  const ease = 0.18;
  const ringX = state.mouse.x;
  const ringY = state.mouse.y;
  cursorRing.style.transform = `translate(${ringX}px, ${ringY}px) translate(-50%,-50%)`;
  cursorDot.style.transform = `translate(${state.mouse.x}px, ${state.mouse.y}px) translate(-50%,-50%)`;
  cursorLabel.style.transform = `translate(${state.mouse.x + 18}px, ${state.mouse.y + 18}px)`;
  // Crosshair
  crosshairH.style.transform = `translateY(${state.mouse.y}px)`;
  crosshairV.style.transform = `translateX(${state.mouse.x}px)`;
  crosshairBox.style.transform = `translate(${state.mouse.x}px, ${state.mouse.y}px) translate(-50%, -50%)`;
  const coordX = String(Math.round(state.mouse.x)).padStart(4, "0");
  const coordY = String(Math.round(state.mouse.y)).padStart(4, "0");
  crosshairLabel.textContent = `X${coordX} · Y${coordY}`;
  crosshairLabel.style.transform = `translate(${state.mouse.x + 12}px, ${state.mouse.y + 12}px)`;
}

// -----------------------------------------------------------
// Live readouts (top bar + side)
// -----------------------------------------------------------
const clockEl = document.getElementById("clock");
const coordEl = document.getElementById("coord");
const rTemp = document.getElementById("r-temp");
const rPlasma = document.getElementById("r-plasma");
const rFlow = document.getElementById("r-flow");
const rHz = document.getElementById("r-hz");
const rHue = document.getElementById("r-hue");
const rSeed = document.getElementById("r-seed");

function padL(n, w, c = "0") {
  return String(n).padStart(w, c);
}
function updateReadouts() {
  const d = new Date();
  clockEl.textContent = `${padL(d.getHours(), 2)}:${padL(d.getMinutes(), 2)}:${padL(
    d.getSeconds(),
    2
  )}`;

  const t = state.time;
  rTemp.textContent = (21.0 + Math.sin(t * 0.3) * 0.8 + (Math.random() - 0.5) * 0.1).toFixed(1) + "°C";
  rPlasma.textContent = (0.8 + Math.sin(t * 0.4) * 0.08 + (Math.random() - 0.5) * 0.005).toFixed(3);
  const flow = 1.0 + Math.sin(t * 0.2) * 0.4;
  rFlow.textContent = (flow >= 1 ? "↗ " : "↘ ") + flow.toFixed(2);
  rHz.textContent = (110 + Math.sin(t * 0.8) * 12).toFixed(2);
  rHue.textContent = Math.round(15 + Math.sin(t * 0.1) * 8) + "°";
  rSeed.textContent = (4291007 + Math.floor(Math.sin(t * 0.05) * 18000)).toLocaleString();
}

// -----------------------------------------------------------
// Manifesto cells — mouse-tracking radial glow
// -----------------------------------------------------------
document.querySelectorAll(".manifesto-cell").forEach((cell) => {
  cell.addEventListener("mousemove", (e) => {
    const r = cell.getBoundingClientRect();
    cell.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
    cell.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
  });
});

// -----------------------------------------------------------
// Cursor state based on what's under it
// -----------------------------------------------------------
function updateCursorContext() {
  // Pick product — if hit, show "OPEN"
  const picked = pickProduct();
  if (picked !== state.hovered) {
    if (state.hovered) state.hovered.userData.hovered = false;
    state.hovered = picked;
    if (picked) {
      picked.userData.hovered = true;
      cursorRing.classList.add("active");
      cursorLabel.textContent = `OPEN · ${picked.userData.data.name}`;
      cursorLabel.classList.add("visible");
    } else {
      cursorRing.classList.remove("active");
      cursorLabel.classList.remove("visible");
    }
  }
}

// -----------------------------------------------------------
// Hover tracking for nav / buttons via DOM
// -----------------------------------------------------------
document.querySelectorAll("a, button").forEach((el) => {
  el.addEventListener("mouseenter", () => {
    cursorRing.classList.add("active");
  });
  el.addEventListener("mouseleave", () => {
    if (!state.hovered) cursorRing.classList.remove("active");
  });
});

// -----------------------------------------------------------
// Main animation loop
// -----------------------------------------------------------
let lastGrain = 0;
let frame = 0;
function animate() {
  frame++;
  state.time += 1 / 60;
  const t = state.time;

  // Smooth mouse velocity
  state.mouse.vx = state.mouse.x - state.mouse.px;
  state.mouse.vy = state.mouse.y - state.mouse.py;
  state.mouse.px = state.mouse.x;
  state.mouse.py = state.mouse.y;

  // Background
  bgUniforms.uTime.value = t;
  bgUniforms.uMouse.value.set(
    state.mouse.x / state.width,
    1 - state.mouse.y / state.height
  );

  // Parallax camera
  const tiltX = state.mouse.nx * 0.25;
  const tiltY = state.mouse.ny * 0.2;
  camera.position.x += (tiltX - camera.position.x) * 0.05;
  camera.position.y += (tiltY - camera.position.y) * 0.05;
  camera.lookAt(0, 0, 0);

  // Animate each product
  products.forEach((p, i) => {
    p.userData.baseY = layouts[i].pos[1];
    animateProductLocal(p, t);
    // Hover: scale boost + liquid boost
    const targetHover = p.userData.hovered ? 1 : 0;
    p.userData.hoverSmooth = (p.userData.hoverSmooth || 0) +
      (targetHover - (p.userData.hoverSmooth || 0)) * 0.1;
    const hs = p.userData.hoverSmooth;
    // Apply hover to shaders
    p.traverse((c) => {
      if (c.isMesh && c.material && c.material.uniforms) {
        if (c.material.uniforms.uTime) c.material.uniforms.uTime.value = t;
        if (c.material.uniforms.uHover) c.material.uniforms.uHover.value = hs;
        if (c.material.uniforms.uMouse) {
          c.material.uniforms.uMouse.value.set(state.mouse.nx, state.mouse.ny);
        }
      }
    });
    // Scale envelope
    const scaleBase = layouts[i].scale;
    const s = scaleBase * (1 + hs * 0.08);
    p.scale.set(s, s, s);
  });

  // Cursor context
  updateCursorContext();

  // Render bg + scene
  bgRenderer.render(bgScene, bgCamera);
  renderer.render(scene, camera);

  // Cursor / crosshair
  updateCursor();

  // Labels
  updateLabels();

  // Readouts
  if (frame % 4 === 0) updateReadouts();

  // Grain — regen every ~4 frames for a moving filmic feel
  if (t - lastGrain > 0.066) {
    drawGrain();
    lastGrain = t;
  }

  // Text wiggles — every char responds to cursor proximity
  updateWiggles(t);

  // 3D hero title + 3D marquee — inflates, rotates, reflects
  updateText3D(t);

  requestAnimationFrame(animate);
}
// -----------------------------------------------------------
// WIGGLES — every character of text reacts to cursor proximity.
// Far away: crisp & readable.  Close: inflated, rotated, blurred,
// chromatic-aberrated, glossy, dissolving.
// -----------------------------------------------------------

const WIGGLE_RADIUS = 240; // px — influence range around cursor

// Elements whose text we leave alone (they update constantly with
// textContent = ..., which would wipe any per-char span structure).
const NO_WIGGLE_IDS = new Set([
  "clock",
  "crosshair-label",
  "cursor-label",
  "r-temp",
  "r-plasma",
  "r-flow",
  "r-hz",
  "r-hue",
  "r-seed",
]);

const wiggleState = {
  chars: [],
  dirty: false,
};

function hasFixedAncestor(el) {
  let p = el;
  while (p && p !== document.body && p !== document.documentElement) {
    try {
      const pos = getComputedStyle(p).position;
      if (pos === "fixed") return true;
    } catch (_) {}
    p = p.parentElement;
  }
  return false;
}

function hasMovingAncestor(el) {
  // The marquee track is translated on each frame — we need to
  // re-measure these chars live rather than trust a cache.
  return !!(el.closest && el.closest(".marquee-track"));
}

function splitTextNode(tn) {
  const out = [];
  const text = tn.nodeValue;
  const frag = document.createDocumentFragment();
  for (const ch of text) {
    if (ch === " " || ch === "\n" || ch === "\t") {
      frag.appendChild(document.createTextNode(ch));
    } else {
      const s = document.createElement("span");
      s.className = "char";
      s.textContent = ch;
      frag.appendChild(s);
      out.push(s);
    }
  }
  tn.parentNode.replaceChild(frag, tn);
  return out;
}

function splitInside(root) {
  const skipTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "CANVAS",
    "svg",
    "SVG",
  ]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (skipTags.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      // Already split
      if (p.classList && p.classList.contains("char"))
        return NodeFilter.FILTER_REJECT;
      // Blacklisted IDs (live-updating readouts)
      if (p.id && NO_WIGGLE_IDS.has(p.id)) return NodeFilter.FILTER_REJECT;
      // Skip if inside an svg anywhere
      if (p.closest && p.closest("svg")) return NodeFilter.FILTER_REJECT;
      // Skip pure whitespace
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  const out = [];
  for (const node of nodes) {
    for (const s of splitTextNode(node)) out.push(s);
  }
  return out;
}

function indexChar(el) {
  // Balloon chars (hero title + footer marquee) get a stronger ambient
  // breathe at rest so they visibly inflate / deflate even when the cursor
  // is far away.
  const balloon = !!(
    el.closest && (el.closest(".hero-title") || el.closest(".foot-marquee"))
  );
  return {
    el,
    cx: 0,
    cy: 0,
    seed: Math.random() * 1000,
    rotSeed: (Math.random() - 0.5) * 2,
    fixed: hasFixedAncestor(el),
    reread: hasMovingAncestor(el),
    lastS: 0,
    modalChar: false,
    balloon,
  };
}

function clearCharStyles(entries) {
  for (const c of entries) {
    c.el.style.transform = "";
    c.el.style.filter = "";
    c.el.style.opacity = "";
    c.el.style.textShadow = "";
  }
}

function measureChars(entries) {
  const sx = window.scrollX;
  const sy = window.scrollY;
  for (const c of entries) {
    const r = c.el.getBoundingClientRect();
    if (c.fixed || c.reread) {
      c.cx = r.left + r.width / 2;
      c.cy = r.top + r.height / 2;
    } else {
      c.cx = r.left + r.width / 2 + sx;
      c.cy = r.top + r.height / 2 + sy;
    }
  }
}

function initWiggles() {
  // 1. Tag existing per-letter spans (logo + hero title) with .char
  const pre = document.querySelectorAll(
    ".logo-roman > span, .logo-kana > span, .hero-title .line > span"
  );
  pre.forEach((el) => {
    if (el.textContent.trim() && !el.classList.contains("char")) {
      el.classList.add("char");
    }
  });

  // 2. Walk the whole body and split every other text node
  splitInside(document.body);

  // 3. Index every .char on the page
  const all = document.querySelectorAll(".char");
  all.forEach((el) => {
    if (el.textContent.trim()) {
      wiggleState.chars.push(indexChar(el));
    }
  });

  // 4. Clear inline styles (in case any were mid-animation), reflow,
  //    then measure resting positions.
  clearCharStyles(wiggleState.chars);
  void document.body.offsetHeight;
  measureChars(wiggleState.chars);

  // 5. When fonts swap in, re-measure (text metrics may shift).
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      wiggleState.dirty = true;
    });
  }
}

function addModalWiggles() {
  // Drop any previous modal entries (we rebuild on each open)
  wiggleState.chars = wiggleState.chars.filter((c) => !c.modalChar);
  // Split modal innards
  const fresh = splitInside(modalInner);
  const batch = [];
  fresh.forEach((el) => {
    const entry = indexChar(el);
    entry.fixed = true; // modal is position: fixed
    entry.modalChar = true;
    wiggleState.chars.push(entry);
    batch.push(entry);
  });
  clearCharStyles(batch);
  // Measure on next frame so modal is laid out
  requestAnimationFrame(() => {
    requestAnimationFrame(() => measureChars(batch));
  });
}

function updateWiggles(t) {
  // Re-measure everything when layout might have changed
  if (wiggleState.dirty) {
    clearCharStyles(wiggleState.chars);
    void document.body.offsetHeight;
    measureChars(wiggleState.chars);
    wiggleState.dirty = false;
  }

  const mx = state.mouse.x;
  const my = state.mouse.y;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const R = WIGGLE_RADIUS;
  const R2 = R * R;
  const ambFreq = 2.0;

  const N = wiggleState.chars.length;
  for (let i = 0; i < N; i++) {
    const c = wiggleState.chars[i];

    // Chars inside a moving parent (marquee) need live rect reads.
    if (c.reread) {
      const r = c.el.getBoundingClientRect();
      c.cx = r.left + r.width / 2;
      c.cy = r.top + r.height / 2;
    }

    const ccx = c.fixed || c.reread ? c.cx : c.cx - sx;
    const ccy = c.fixed || c.reread ? c.cy : c.cy - sy;

    const dx = mx - ccx;
    const dy = my - ccy;
    const d2 = dx * dx + dy * dy;

    if (d2 > R2) {
      // Out of effect range — just ambient breath, and only write
      // when we were previously wiggling OR on a lazy stagger schedule.
      // Balloon chars (hero + marquee) breathe much harder — they're
      // inflated letters that visibly pulse.
      const ambAmp = c.balloon ? 0.045 : 0.015;
      // Balloons get their own stagger cadence too so they update every
      // frame (idle breathing must be continuous, not stuttered).
      if (c.lastS > 0.005) {
        const amb = Math.sin(t * ambFreq + c.seed) * ambAmp;
        const style = c.el.style;
        style.transform = `scale(${(1 + amb).toFixed(4)})`;
        style.filter = "";
        style.opacity = "";
        style.textShadow = "";
        c.lastS = 0;
      } else if (c.balloon || i % 90 === (frame || 0) % 90) {
        // Balloons animate every frame, others lazy-stagger
        const amb = Math.sin(t * ambFreq + c.seed) * ambAmp;
        c.el.style.transform = `scale(${(1 + amb).toFixed(4)})`;
      }
      continue;
    }

    const d = Math.sqrt(d2);
    const s = 1 - d / R; // 0..1, 1 = cursor dead on char
    const ss = s * s; // sharpen falloff
    const sss = ss * s; // even sharper for blur/gloss
    c.lastS = s;

    // Unit vector pointing AWAY from cursor
    const invD = 1 / (d + 0.5);
    const dirX = -dx * invD;
    const dirY = -dy * invD;

    // Push (repulsion) + wiggle jitter (high-freq sin)
    const push = ss * 30;
    const wf = 5 + (c.seed % 3);
    const wigAmp = ss * 14;
    const wigX = Math.sin(t * wf + c.seed) * wigAmp;
    const wigY = Math.cos(t * (wf + 0.3) + c.seed * 1.7) * wigAmp;

    // Rotation: random per-char bias + flicker
    const rot =
      c.rotSeed * ss * 55 + Math.sin(t * 9 + c.seed) * ss * 28;

    // Inflate + ambient breath
    const amb = Math.sin(t * ambFreq + c.seed) * 0.015;
    const scale = 1 + amb + ss * 1.4;

    // Blur for dissolve
    const blur = sss * 9;

    // Opacity drop — never fully invisible so mass is still felt
    const opacity = 1 - ss * 0.45;

    // Gloss: chromatic aberration + white bloom
    const caX = ss * 5;
    const caY = ss * 2;
    const bloom = sss * 3;

    const tx = dirX * push + wigX;
    const ty = dirY * push + wigY;

    const style = c.el.style;
    style.transform =
      "translate(" +
      tx.toFixed(1) +
      "px," +
      ty.toFixed(1) +
      "px) scale(" +
      scale.toFixed(3) +
      ") rotate(" +
      rot.toFixed(1) +
      "deg)";
    style.filter = blur > 0.15 ? "blur(" + blur.toFixed(2) + "px)" : "";
    style.opacity = opacity.toFixed(3);
    style.textShadow =
      ss > 0.03
        ? "0 0 " +
          bloom.toFixed(1) +
          "px rgba(255,255,255," +
          (ss * 0.7).toFixed(2) +
          ")," +
          caX.toFixed(1) +
          "px " +
          caY.toFixed(1) +
          "px 0 rgba(255,69,0," +
          (ss * 0.85).toFixed(2) +
          ")," +
          (-caX).toFixed(1) +
          "px " +
          (-caY).toFixed(1) +
          "px 0 rgba(10,150,230," +
          (ss * 0.45).toFixed(2) +
          ")"
        : "";
  }
}

// Layout changes → remeasure. NOTE: scroll does NOT dirty — positions
// are stored as page coords and we subtract scrollY in the hot loop.
// Re-measuring every scroll event would tank perf in heavy text areas.
window.addEventListener("resize", () => {
  wiggleState.dirty = true;
});

// Kick off the whole system once the DOM is parsed
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initWiggles);
} else {
  initWiggles();
}

drawGrain();
animate();

// -----------------------------------------------------------
// Hover-reset when mouse leaves window
// -----------------------------------------------------------
window.addEventListener("mouseleave", () => {
  if (state.hovered) {
    state.hovered.userData.hovered = false;
    state.hovered = null;
  }
  cursorRing.classList.remove("active");
  cursorLabel.classList.remove("visible");
});

// -----------------------------------------------------------
// Intro reveal
// -----------------------------------------------------------
document.body.style.opacity = "0";
document.body.style.transition = "opacity 1.2s ease";
requestAnimationFrame(() => {
  document.body.style.opacity = "1";
});
