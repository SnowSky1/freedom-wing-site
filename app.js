const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
let resources, heroScene, storyScene, labScene, gameScene;
let gameGallery = null;
let gameIndex = 0;
let gameSwitchToken = 0;
let gameInitPromise = null;
let gameActiveId = null;
const galleryResourceCache = new Map();
let visible = !document.hidden, heroVisible = true, storyVisible = false, labVisible = false, gameVisible = false;
let gameFailed = false;
let storyProgress = 0, targetProgress = 0, anatomyMode = 'xray';
let lastTime = 0, raf = 0, playback = null, labForm = 's1', labBones = false;
let pausedPlayback = null, scrubbed = false, contextFailure = false;
let labSpread = 0;
let geometry = {};
const story = $('#story');
const lab = $('#lab');
const gameDisplay = $('#game-display');
const gamePrevious = $('#game-prev');
const gameNext = $('#game-next');
const storyCanvas = $('#story-canvas');
const storyForm = $('#story-form');
const storyNumber = $('#story-number');
const storyAngle = $('#story-angle');
const rulerMarker = $('.ruler-line i');
const progressLine = $('.page-progress');
const scrub = $('#animation-scrub');
const progressOutput = $('#animation-progress');
const labStatus = $('#lab-state');
const controls = $$('.lab-controls button, #play-pause, #animation-scrub, #assembly-scrub');
const assemblyScrub = $('#assembly-scrub');
const hero = $('#top');
const heroEcho = $('#hero-echo');
const echoContext = heroEcho.getContext('2d');
let echoSize = '';

function measure() {
  const heroPlate = $('.hero-visual');
  hero.style.setProperty('--hero-media-top', `${heroPlate.offsetTop}px`);
  hero.style.setProperty('--hero-media-height', `${heroPlate.offsetHeight}px`);
  const scroll = window.scrollY;
  const top = element => element.getBoundingClientRect().top + scroll;
  geometry = {
    start: top(story),
    chapters: [top($('#design')), top($('#assembly')), top($('#transformation')), top($('#anatomy'))],
    end: top(story) + story.offsetHeight,
    view: innerHeight,
    page: document.documentElement.scrollHeight - innerHeight,
  };
  onScroll();
}

function updateHero(time, delta) {
  if (!heroScene) return;
  // A still studio view on arrival; the slight scroll response leads into the
  // rotating study below without making the opening title compete with motion.
  const departure = reducedMotion ? 0 : clamp(scrollY / innerHeight);
  heroScene.yaw = 1.2 + departure * .16;
  heroScene.roll = -.34;
  heroScene.pitch = -.12;
  heroScene.zoom = innerWidth < 700 ? 1.14 : 1.3;
  heroScene.render(time, delta);
  if (innerWidth > 700 && echoContext) {
    const source = heroScene.renderer.domElement;
    const size = `${source.width}:${source.height}`;
    if (size !== echoSize) {
      heroEcho.width = Math.max(1, Math.round(source.width / 3));
      heroEcho.height = Math.max(1, Math.round(source.height / 3));
      echoSize = size;
    }
    echoContext.clearRect(0, 0, heroEcho.width, heroEcho.height);
    echoContext.drawImage(source, 0, 0, heroEcho.width, heroEcho.height);
  }
}

function onScroll() {
  const y = scrollY;
  progressLine.style.transform = `scaleX(${geometry.page ? clamp(y / geometry.page) : 0})`;
  // Progress follows section positions, so the same choreography fits mobile.
  const stops = geometry.chapters;
  const index = y < stops[1] ? 0 : y < stops[2] ? 1 : y < stops[3] ? 2 : 3;
  const next = stops[index + 1] ?? geometry.end - geometry.view * .35;
  targetProgress = clamp(index + (y - stops[index]) / (next - stops[index]), -.8, 4);
  requestFrame();
}

function requestFrame() {
  if (!raf && visible) raf = requestAnimationFrame(frame);
}

function setLabStatus(text) { labStatus.textContent = text; }
function setAssemblyProgress(value) {
  labSpread = clamp(value);
  assemblyScrub.value = (labSpread * 100).toFixed(1);
  $('#assembly-progress').value = `${Math.round(labSpread * 100)}%`;
  assemblyScrub.setAttribute('aria-valuetext', `部件展开 ${Math.round(labSpread * 100)}%`);
  $('#play-explode').textContent = labSpread > .5 ? '组合' : '展开';
  $('#play-explode').setAttribute('aria-pressed', String(labSpread > .5));
}
function setProgress(value) {
  scrub.value = (value * 100).toFixed(1);
  progressOutput.value = `${Math.round(value * 100)}%`;
  scrub.setAttribute('aria-valuetext', `步枪至狙击变形 ${Math.round(value * 100)}%`);
}
function updateFormUI() {
  $$('[data-form]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.form === labForm)));
  $('#lab-form-number').textContent = labForm.toUpperCase();
  $('#lab-form-label').textContent = labForm === 's1' ? 'ASSAULT FORM' : 'SNIPER FORM';
}
function updatePlayUI() {
  $('#play-pause').textContent = playback ? 'Ⅱ' : '▶';
  $('#play-pause').setAttribute('aria-label', playback ? '暂停当前动画' : pausedPlayback ? '继续当前动画' : '播放变形动画');
  $('#play-transform').setAttribute('aria-busy', String(playback?.type === 'transform'));
  $('#play-reload').setAttribute('aria-busy', String(playback?.type === 'reload'));
  $('#play-explode').setAttribute('aria-busy', String(playback?.type === 'assembly'));
  $('#play-demo').setAttribute('aria-pressed', String(playback?.type === 'demo' || pausedPlayback?.type === 'demo'));
}
function cancelPlayback() {
  playback = pausedPlayback = null;
  updatePlayUI();
}
function chooseForm(form) {
  if (!labScene) return;
  cancelPlayback();
  scrubbed = false;
  labForm = form;
  setAssemblyProgress(0);
  labScene.setForm(form);
  setProgress(form === 's1' ? 0 : 1);
  updateFormUI();
  setLabStatus(`${form === 's1' ? '步枪' : '狙击'}形态 · 等待探索`);
  requestFrame();
}
function beginAssembly(target = labSpread > .5 ? 0 : 1) {
  if (!labScene || contextFailure) return;
  cancelPlayback();
  playback = { type: 'assembly', position: 0, end: 60, rate: 30, from: labSpread, to: target };
  setLabStatus(target ? '部件展开 · 播放中' : '部件组合 · 播放中');
  updatePlayUI();
  requestFrame();
}
function beginDemo() {
  if (!labScene || contextFailure) return;
  chooseForm('s1');
  labScene.resetView();
  labScene.autoRotate = false;
  $('#toggle-rotate').setAttribute('aria-pressed', 'false');
  $('#toggle-rotate').textContent = '自转';
  playback = { type: 'demo', position: 0, end: 372, rate: 30 };
  setLabStatus('完整演示 · 展开部件');
  updatePlayUI();
  requestFrame();
}
function beginAnimation(type) {
  if (!labScene || contextFailure) return;
  cancelPlayback();
  // A manually scrubbed intermediate pose continues from its own frame.
  let clip, start = 0, target = labForm;
  if (type === 'transform') {
    if (scrubbed) {
      clip = 'switchsub_s1_to_s2';
      start = Number(scrub.value) / 100 * 50;
      target = 's2';
    } else {
      clip = labForm === 's1' ? 'switchsub_s1_to_s2' : 'switchsub_s2_to_s1';
      target = labForm === 's1' ? 's2' : 's1';
    }
  } else {
    if (scrubbed) labScene.setForm(labForm);
    clip = `reload_${labForm}`;
  }
  const data = resources.runtime.animations[labScene.kind][clip];
  playback = { type, clip, position: start, rate: data.frame_rate, end: data.frame_count - 1, target };
  scrubbed = false;
  setLabStatus(type === 'reload' ? '换弹动作 · 播放中' : '形态切换 · 播放中');
  updatePlayUI();
  requestFrame();
}
function stepPlayback(delta) {
  if (!playback || !labScene) return;
  playback.position = Math.min(playback.end, playback.position + delta * playback.rate);
  if (playback.type === 'assembly') {
    setAssemblyProgress(lerp(playback.from, playback.to, smooth(playback.position / playback.end)));
    if (playback.position >= playback.end) {
      const opened = playback.to === 1;
      playback = null;
      updatePlayUI();
      setLabStatus(opened ? '展开完成 · 拖动查看各个部件' : '组合完成 · 部件已归位');
    }
    return;
  }
  if (playback.type === 'demo') {
    const t = playback.position / 30;
    const spread = smooth(t / 2.2) * (1 - smooth((t - 4.8) / 1.8));
    setAssemblyProgress(spread);
    labScene.yaw = Math.PI / 2 - .32 + Math.PI * 2 * smooth((t - 1.2) / 5);
    labScene.pitch = -.1 - spread * .2;
    if (t < 6.6) {
      labScene.setForm('s1');
      setProgress(0);
    } else if (t < 10.6) {
      const progress = smooth((t - 6.6) / 1.8);
      labScene.setPose('switchsub_s1_to_s2', progress * 50);
      setProgress(progress);
      labForm = progress < .5 ? 's1' : 's2';
    } else {
      const progress = smooth((t - 10.6) / 1.8);
      labScene.setPose('switchsub_s2_to_s1', progress * 50);
      setProgress(1 - progress);
      labForm = progress < .5 ? 's2' : 's1';
    }
    updateFormUI();
    const label = t < 2.2 ? '展开部件' : t < 4.8 ? '旋转观察' : t < 6.6 ? '重新组合' : t < 8.4 ? '切换狙击形态' : t < 10.6 ? '狙击形态展示' : '收拢为步枪';
    if (playback.label !== label) { setLabStatus(`完整演示 · ${label}`); playback.label = label; }
    if (playback.position >= playback.end) {
      playback = null;
      labForm = 's1';
      labScene.setForm('s1');
      labScene.resetView();
      setAssemblyProgress(0);
      setProgress(0);
      updateFormUI();
      updatePlayUI();
      setLabStatus('完整演示结束 · 步枪形态');
    }
    return;
  }
  labScene.setPose(playback.clip, playback.position);
  if (playback.type === 'transform') {
    const p = playback.position / playback.end;
    setProgress(playback.clip === 'switchsub_s1_to_s2' ? p : 1 - p);
  }
  if (playback.position >= playback.end) {
    const done = playback;
    playback = null;
    labForm = done.target;
    labScene.setForm(labForm);
    setProgress(labForm === 's1' ? 0 : 1);
    updateFormUI();
    updatePlayUI();
    setLabStatus(`${done.type === 'reload' ? '换弹完成' : '变形完成'} · ${labForm === 's1' ? '步枪' : '狙击'}形态`);
  }
}

function updateStory(time, delta) {
  if (!storyScene) return;
  const p = storyProgress;
  const enter = smooth((p + .7) / .55);
  storyCanvas.style.opacity = enter;
  storyCanvas.style.transform = reducedMotion ? 'none' : `translateY(${(1 - enter) * 65}px)`;
  const transform = smooth((p - 1.92) / .92);
  const bones = smooth((p - 2.8) / .36);
  const spread = reducedMotion ? (p >= 1 && p < 1.5 ? 1 : 0)
    : smooth((p - .65) / .53) * (1 - smooth((p - 1.42) / .50));
  if (reducedMotion) {
    storyScene.yaw = Math.PI / 2 - .25;
    storyScene.roll = -.08;
    storyScene.setForm(p < 2.4 ? 's1' : 's2');
  } else {
    // A slow turn, one full revolution through the transformation, then settle
    // on an unobstructed profile for the bone study.
    if (p < .65) storyScene.yaw = lerp(1.17, 1.55, smooth((p + .3) / .95));
    else if (p < 1.3) storyScene.yaw = lerp(1.55, 2.1, smooth((p - .65) / .65));
    else if (p < 1.95) storyScene.yaw = lerp(2.1, Math.PI * 2 + 1.3, smooth((p - 1.3) / .65));
    else if (p < 2.85) storyScene.yaw = lerp(Math.PI * 2 + 1.3, Math.PI * 4 + 1.25, smooth((p - 1.95) / .9));
    else storyScene.yaw = lerp(Math.PI * 4 + 1.25, Math.PI * 4 + 1.8, smooth((p - 2.85) / 1.1));
    storyScene.roll = lerp(-.14, .07, smooth((p - .5) / 2.8));
    storyScene.pitch = -.09 - spread * .23;
    storyScene.setPose('switchsub_s1_to_s2', transform * 50);
  }
  storyScene.setExplosion(spread);
  storyScene.setStructure(bones > .001 ? anatomyMode : 'solid', bones);
  storyScene.zoom = lerp(1, innerWidth < 700 ? 1.02 : .87, smooth((p - 1.92) / .93));
  storyScene.render(time, delta, Math.sin(transform * Math.PI) * .25);
  const chapter = p < .65 ? 1 : p < 1.92 ? 2 : p < 2.85 ? 3 : 4;
  storyNumber.textContent = `0${chapter}`;
  storyForm.textContent = chapter === 4 ? (anatomyMode === 'solid' ? 'S2 · 完整材质' : '18 BONES · 骨骼结构')
    : chapter === 2 ? `${p < 1.42 ? '部件展开' : '部件组合'} · ${Math.round(spread * 100)}%`
    : transform < .03 ? 'S1 · 步枪形态' : transform > .97 ? 'S2 · 狙击形态' : `S1 → S2 · 变形 ${Math.round(transform * 100)}%`;
  storyAngle.textContent = `${String(Math.round((storyScene.yaw * 180 / Math.PI) % 360)).padStart(3, '0')}°`;
  rulerMarker.style.left = `${clamp(p / 4) * 100}%`;
  const phase = p < 1.18 ? 'open' : p < 1.42 ? 'inspect' : 'close';
  $$('[data-assembly-phase]').forEach(item => item.classList.toggle('active', chapter === 2 && item.dataset.assemblyPhase === phase));
}

function frame(timestamp) {
  raf = 0;
  if (!visible) return;
  const delta = Math.min((timestamp - (lastTime || timestamp)) / 1000, .05);
  lastTime = timestamp;
  storyProgress = reducedMotion ? targetProgress : lerp(storyProgress, targetProgress, 1 - Math.exp(-delta * 11));
  if (Math.abs(storyProgress - targetProgress) < .0002) storyProgress = targetProgress;
  if (heroVisible) updateHero(timestamp / 1000, delta);
  if (storyVisible) updateStory(timestamp / 1000, delta);
  if (labVisible && labScene) {
    stepPlayback(delta);
    labScene.setExplosion(labSpread);
    labScene.setStructure(labBones ? 'xray' : 'solid');
    const pulse = playback?.type === 'transform' ? Math.sin(playback.position / playback.end * Math.PI) : 0;
    labScene.render(timestamp / 1000, delta, pulse);
  }
  if (gameVisible && gameScene && !gameFailed) {
    // A fixed presentation: only time changes its heading. No user-controlled
    // camera, pose, animation, or material controls are attached to this scene.
    gameScene.render(timestamp / 1000, delta);
  }
  // Suspend both WebGL renderers when their sections are out of view.
  if ((heroVisible && heroScene) || (storyVisible && storyScene) || (labVisible && labScene) || (gameVisible && gameScene && !gameFailed)) requestFrame();
}

const visibilityObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.target === hero) heroVisible = entry.isIntersecting;
    if (entry.target === story) storyVisible = entry.isIntersecting;
    if (entry.target === lab) {
      labVisible = entry.isIntersecting;
      if (labVisible && resources && !labScene && !contextFailure) initLab();
    }
    if (entry.target === gameDisplay) {
      gameVisible = entry.isIntersecting;
      if (gameVisible && resources && !gameScene && !gameFailed && !gameInitPromise) initGameDisplay();
    }
  });
  lastTime = 0;
  requestFrame();
}, { rootMargin: '80px 0px' });
visibilityObserver.observe(story);
visibilityObserver.observe(lab);
visibilityObserver.observe(hero);
visibilityObserver.observe(gameDisplay);

const navObserver = new IntersectionObserver(entries => {
  const current = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (current) $$('.nav a').forEach(link => {
    const active = link.hash === `#${current.target.id}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
  });
}, { rootMargin: '-20% 0px -45% 0px', threshold: 0 });
$$('.hero, .story-step, #experience, #performance, .closing').forEach(section => navObserver.observe(section));

$$('[data-anatomy]').forEach(button => button.addEventListener('click', () => {
  anatomyMode = button.dataset.anatomy;
  $$('[data-anatomy]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  requestFrame();
}));
$$('[data-form]').forEach(button => button.addEventListener('click', () => chooseForm(button.dataset.form)));
$('#play-transform').addEventListener('click', () => beginAnimation('transform'));
$('#play-reload').addEventListener('click', () => beginAnimation('reload'));
$('#play-explode').addEventListener('click', () => beginAssembly());
$('#play-demo').addEventListener('click', () => {
  if (playback?.type === 'demo' || pausedPlayback?.type === 'demo') { cancelPlayback(); setLabStatus('演示已停止 · 可继续手动探索'); }
  else beginDemo();
});
$('#play-pause').addEventListener('click', () => {
  if (playback) {
    pausedPlayback = playback; playback = null;
    setLabStatus('动画已暂停 · 可继续播放');
  } else if (pausedPlayback) {
    playback = pausedPlayback; pausedPlayback = null;
    const labels = { reload: '换弹动作', transform: '形态切换', assembly: '部件展开／组合', demo: '完整演示' };
    setLabStatus(`${labels[playback.type]} · 播放中`);
  } else beginAnimation('transform');
  updatePlayUI();
  requestFrame();
});
$('#toggle-bones').addEventListener('click', event => {
  labBones = !labBones;
  event.currentTarget.setAttribute('aria-pressed', String(labBones));
  requestFrame();
});
$('#toggle-rotate').addEventListener('click', event => {
  if (!labScene) return;
  labScene.autoRotate = !labScene.autoRotate;
  // Explicitly requested rotation can run even when passive motion is reduced.
  if (labScene.autoRotate) labScene.reducedMotion = false;
  event.currentTarget.setAttribute('aria-pressed', String(labScene.autoRotate));
  event.currentTarget.textContent = labScene.autoRotate ? '停止自转' : '自转';
  requestFrame();
});
$('#toggle-view').addEventListener('click', event => {
  if (!labScene) return;
  const next = labScene.kind === 'fp' ? 'tp' : 'fp';
  cancelPlayback();
  scrubbed = false;
  labScene.setKind(next);
  labScene.setForm(labForm);
  setProgress(labForm === 's1' ? 0 : 1);
  event.currentTarget.setAttribute('aria-pressed', String(next === 'tp'));
  event.currentTarget.textContent = next === 'tp' ? '第一人称' : '第三人称';
  setLabStatus(`${next === 'tp' ? '第三' : '第一'}人称模型 · ${labForm === 's1' ? '步枪' : '狙击'}形态`);
  requestFrame();
});
$('#reset-view').addEventListener('click', () => { labScene?.resetView(); requestFrame(); });
scrub.addEventListener('input', () => {
  if (!labScene) return;
  cancelPlayback();
  scrubbed = true;
  const p = Number(scrub.value) / 100;
  labScene.setPose('switchsub_s1_to_s2', p * 50);
  setProgress(p);
  labForm = p >= .5 ? 's2' : 's1';
  updateFormUI();
  setLabStatus(`手动变形 · ${Math.round(p * 100)}%`);
  requestFrame();
});
assemblyScrub.addEventListener('input', () => {
  if (!labScene) return;
  cancelPlayback();
  setAssemblyProgress(Number(assemblyScrub.value) / 100);
  setLabStatus(`结构演示 · 部件展开 ${Math.round(labSpread * 100)}%`);
  requestFrame();
});

const dialog = $('#image-dialog');
function openImage(file, title) {
  $('#dialog-image').src = `./assets/${file}`;
  $('#dialog-image').alt = title;
  $('#dialog-title').textContent = title;
  dialog.showModal();
  document.body.style.overflow = 'hidden';
}
$('#open-stats').addEventListener('click', () => openImage('game-stats-1.jpg', '自由之翼 · 原始属性卡'));
$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
dialog.addEventListener('close', () => { document.body.style.overflow = ''; });

function showFailure(message, storyOnly = false) {
  if (!storyOnly) {
    contextFailure = true;
    controls.forEach(control => { control.disabled = true; });
    setLabStatus('三维展示暂不可用 · 可浏览游戏原图');
    $('#lab-fallback').classList.remove('loaded');
  }
  $('#story-fallback').classList.remove('loaded');
  $('#hero-fallback').classList.remove('loaded');
  $('.loading-label').textContent = message;
  storyCanvas.style.opacity = 0;
}

let SceneClass;
let loadResourcePackage;
function fallbackGameDisplay() {
  gameFailed = true;
  gameDisplay.classList.remove('is-live');
  $('#game-display-status').textContent = '原始游戏图鉴';
}
function updateGameGalleryLabel() {
  const item = gameGallery?.weapons?.[gameIndex];
  if (!item) return;
  $('#game-gallery-name').textContent = item.label;
  $('#game-gallery-latin').textContent = `${String(gameIndex + 1).padStart(2, '0')} / ${String(gameGallery.weapons.length).padStart(2, '0')}${item.appearanceLabel ? ' · ' + item.appearanceLabel : ''}`;
  gameDisplay.setAttribute('aria-label', `${item.label}，游戏原场景检视，自动旋转`);
}
async function setGameWeapon(index) {
  if (!gameGallery?.weapons?.length || !SceneClass || gameFailed) return;
  const items = gameGallery.weapons;
  const nextIndex = (index + items.length) % items.length;
  const item = items[nextIndex];
  const token = ++gameSwitchToken;
  gameDisplay.dataset.loading = 'true';
  gameDisplay.setAttribute('aria-busy', 'true');
  gamePrevious.disabled = true;
  gameNext.disabled = true;
  try {
    if (!galleryResourceCache.has(item.id)) {
      galleryResourceCache.set(item.id, loadResourcePackage(item).catch(error => {
        galleryResourceCache.delete(item.id);
        throw error;
      }));
    }
    const galleryResources = await galleryResourceCache.get(item.id);
    if (token !== gameSwitchToken) return;
    const effects = await SceneClass.loadInspectionEffects(galleryResources);
    if (token !== gameSwitchToken) { effects.forEach(entry => entry.effect.dispose()); return; }
    if (gameScene) gameScene.replaceResources(galleryResources);
    else gameScene = new SceneClass($('#game-canvas'), galleryResources, {
      dark: true, interactive: false, reducedMotion, inspection: true,
    });
    gameScene.setForm('s1');
    gameScene.setExplosion(0);
    gameScene.setStructure('solid');
    gameScene.yaw = -Math.PI / 2 + .14;
    gameScene.pitch = -.04;
    gameScene.roll = 0;
    gameScene.zoom = 1;
    gameScene.autoRotate = true;
    gameScene.renderer.toneMappingExposure = .84;
    gameScene.attachInspectionEffects(effects);
    gameScene.resize();
    gameScene.render(0, 0);
    gameIndex = nextIndex;
    gameActiveId = item.id;
    updateGameGalleryLabel();
    gameDisplay.classList.add('is-live');
    gameDisplay.dataset.weapon = item.id;
    $('#game-display-status').textContent = reducedMotion ? '游戏检视 · 仅供展示' : '自动旋转 · 仅供展示';
    requestFrame();
  } catch (error) {
    console.error('游戏武器检视加载失败', item.id, error);
    $('#game-display-status').textContent = '本次载入未完成，请再次切换';
    // Keep the previous successfully rendered gun and its matching label.
    requestFrame();
  } finally {
    if (token === gameSwitchToken) {
      gameDisplay.dataset.loading = 'false';
      gameDisplay.setAttribute('aria-busy', 'false');
      gamePrevious.disabled = false;
      gameNext.disabled = false;
    }
  }
}
function initGameDisplay() {
  if (gameInitPromise) return gameInitPromise;
  gameInitPromise = (async () => {
    if (!gameGallery) {
      const response = await fetch('./assets/gallery.json');
      if (!response.ok) throw new Error(`gallery.json: HTTP ${response.status}`);
      gameGallery = await response.json();
      gameIndex = Math.max(0, gameGallery.weapons.findIndex(item => item.id === 'freedom'));
    }
    await setGameWeapon(gameIndex);
  })().catch(error => {
    console.error('游戏检视初始化失败', error);
    fallbackGameDisplay();
  }).finally(() => { gameInitPromise = null; });
  return gameInitPromise;
}
$('#game-canvas').addEventListener('modelerror', fallbackGameDisplay);
gamePrevious.addEventListener('click', () => setGameWeapon(gameIndex - 1));
gameNext.addEventListener('click', () => setGameWeapon(gameIndex + 1));
function initLab() {
  try {
    labScene = new SceneClass($('#lab-canvas'), resources, { interactive: true, reducedMotion });
    $('#lab-fallback').classList.add('loaded');
    controls.forEach(control => { control.disabled = false; });
    chooseForm('s1');
  } catch (error) {
    console.error('展台加载失败', error);
    showFailure('当前设备无法显示三维模型，已展示游戏原图。');
  }
}
async function init() {
  measure();
  try {
    const module = await import('./weapon-scene.js');
    SceneClass = module.WeaponScene;
    loadResourcePackage = module.loadResourcePackage;
    resources = await module.loadResources();
    heroScene = new SceneClass($('#hero-canvas'), resources, { reducedMotion });
    $('#hero-fallback').classList.add('loaded');
    storyScene = new SceneClass(storyCanvas, resources, { reducedMotion });
    $('#story-fallback').classList.add('loaded');
    document.documentElement.dataset.modelReady = 'true';
    if (labVisible) initLab();
    if (gameVisible) initGameDisplay();
    storyProgress = targetProgress;
    requestFrame();
  } catch (error) {
    console.error('模型加载失败', error);
    document.documentElement.dataset.modelReady = 'failed';
    showFailure('三维模型暂未加载，可继续浏览原图与产品介绍。');
  }
}

addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', measure, { passive: true });
addEventListener('load', measure);
document.addEventListener('visibilitychange', () => { visible = !document.hidden; lastTime = 0; requestFrame(); });
motionQuery.addEventListener('change', event => {
  reducedMotion = event.matches;
  if (heroScene) heroScene.reducedMotion = reducedMotion;
  if (storyScene) storyScene.reducedMotion = reducedMotion;
  if (gameScene) {
    gameScene.reducedMotion = reducedMotion;
    if (!gameFailed) $('#game-display-status').textContent = reducedMotion ? '游戏图鉴 · 仅供展示' : '自动旋转 · 仅供展示';
  }
  if (labScene) {
    labScene.reducedMotion = reducedMotion;
    if (reducedMotion) {
      labScene.autoRotate = false;
      $('#toggle-rotate').setAttribute('aria-pressed', 'false');
      $('#toggle-rotate').textContent = '自转';
    }
  }
  requestFrame();
});
$$('#hero-canvas, #story-canvas, #lab-canvas').forEach(element => element.addEventListener('modelerror', event => showFailure(event.detail)));
window.__freedomWing = {
  getState: () => ({
    ready: Boolean(storyScene), heroVisible, storyVisible, labVisible, gameVisible, gameFailed, reducedMotion,
    progress: storyProgress, targetProgress,
    hero: heroScene?.diagnostics(), story: storyScene?.diagnostics(), lab: labScene?.diagnostics(),
    game: gameScene?.diagnostics(),
    gallery: { activeId: gameActiveId, index: gameIndex, count: gameGallery?.weapons.length ?? 0, loading: gameDisplay.dataset.loading === 'true' },
    form: labForm, playback: playback ? { ...playback } : null,
    paused: Boolean(pausedPlayback), contextFailure,
  }),
};
init();
