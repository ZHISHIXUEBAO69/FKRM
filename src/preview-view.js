/* ============================================================
 * 无画布回退渲染层（预览模拟器等无画布环境专用）
 * 微信预览模拟器的 wx 桩对象没有画布 API（createCanvasContext 等），
 * canvas 游戏无法在其中运行。本模块用原生组件（view + 内联样式）
 * 渲染同一套 core.js 游戏状态：游戏逻辑一行不改，只是"画法"不同。
 *
 *  - createNoopCtx()   让 core.js 的 render() 安全空转
 *  - buildViewModel()  把游戏状态翻译成组件样式/文本（纯函数，可 Node 测试）
 *  - start()           30fps setData 驱动组件刷新
 *
 * 角色：人类球员（左侧出脚方）踢大黄狗（右侧目标）。
 * 动画公式与 src/core.js 的 drawHumanEntity / drawDogEntity 逐行对应。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaojiPreview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 设计稿常量（与 core.js 保持一致） */
  var DW = 750;
  var HUMAN_X = 235;
  var DOG_X = 505;
  var GROUND_RATIO = 0.72;
  var HUMAN_PHASE = {
    windup:  { dur: 90,  next: 'kick' },
    kick:    { dur: 240, next: 'recover' },
    recover: { dur: 200, next: 'idle' },
    cheer:   { dur: 900, next: 'idle' }
  };
  var DOG_PHASE = {
    tell:     { dur: 260,  next: 'dodge' },
    dodge:    { dur: 340,  next: 'idle' },
    hit:      { dur: 280,  next: 'idle' },
    ko:       { dur: 1100, next: 'respawn' }
  };
  var FUR = '#f5b93c', FUR_D = '#e09a24', FUR_L = '#ffd98a', LINE = '#7a4d12';
  var SKIN = '#f2c49b';

  /* ---------- 空转 ctx：core.js 的 render() 调用全部安全落地 ---------- */
  function createNoopCtx() {
    var names = ['setTransform', 'clearRect', 'translate', 'rotate', 'scale',
      'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
      'arc', 'arcTo', 'rect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo',
      'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText',
      'clip', 'setLineDash'];
    var ctx = {};
    names.forEach(function (n) { ctx[n] = function () {}; });
    ctx.measureText = function () { return { width: 0 }; };
    var grad = function () { return { addColorStop: function () {} }; };
    ctx.createLinearGradient = grad;
    ctx.createRadialGradient = grad;
    ctx.createCircularGradient = grad;
    return ctx;
  }

  /* ---------- 样式工具 ---------- */
  function num(v) {
    if (!isFinite(v)) return 0;
    return Math.round(v * 100) / 100;
  }
  function px(v) { return num(v) + 'px'; }

  /**
   * 游戏状态 -> 组件视图模型（纯函数）
   * @param game  core.js launch() 返回值（含 debug.{S,human,dog,levels}）
   * @param vw    视口宽（CSS px）
   * @param vh    视口高（CSS px）
   * @param CONFIG core.js 导出的 CONFIG（含 LEVELS / assets / achievements）
   * @param imgOk 立绘图片是否可用（false = 图片加载失败，回退代码绘制部件）
   */
  function buildViewModel(game, vw, vh, CONFIG, imgOk) {
    var dbg = (game && game.debug) || {};
    var S = dbg.S || {};
    var human = dbg.human || { phase: 'idle', phaseT: 0, x: HUMAN_X };
    var dog = dbg.dog || { phase: 'idle', phaseT: 0, x: DOG_X, hp: 1, maxHp: 1, knock: 0, sway: 0, rage: null };
    var levels = dbg.levels || (CONFIG && CONFIG.LEVELS) || [];
    CONFIG = CONFIG || {};
    if (imgOk === undefined) imgOk = true;

    var s = (vw && vw > 0) ? vw / DW : 1;          // 设计稿 -> 屏幕缩放
    var DH = (vh && vh > 0) ? vh / s : 1334;
    var ground = DH * GROUND_RATIO;
    var now = S.now || 0;
    var scene = S.scene || 'menu';
    var levelIdx = Math.max(0, Math.min(S.level || 0, levels.length - 1));
    var lv = levels[levelIdx] || {};

    /* 组件片段工具（坐标均为实体局部设计单位，y 向上为负） */
    function seg(x1, y1, x2, y2, thick) {
      var dx = x2 - x1, dy = y2 - y1;
      var len = Math.sqrt(dx * dx + dy * dy);
      var ang = Math.atan2(dy, dx) * 180 / Math.PI;
      return 'left:' + px((x1 + x2) / 2 * s - len * s / 2) +
        ';top:' + px((y1 + y2) / 2 * s - thick * s / 2) +
        ';width:' + px(len * s) + ';height:' + px(thick * s) +
        ';transform:rotate(' + num(ang) + 'deg);border-radius:' + px(thick * s / 2) + ';';
    }
    function dot(cx, cy, r) {
      return 'left:' + px((cx - r) * s) + ';top:' + px((cy - r) * s) +
        ';width:' + px(2 * r * s) + ';height:' + px(2 * r * s) + ';';
    }
    function box(x, y, w, h, extra) {
      return 'left:' + px(x * s) + ';top:' + px(y * s) +
        ';width:' + px(w * s) + ';height:' + px(h * s) + ';' + (extra || '');
    }
    function absBox(x, y, w, h, extra) {   // 屏幕绝对坐标（不乘 s 的局部用）
      return box(x, y, w, h, extra);
    }

    /* ================= 大黄狗（被踢目标，公式对应 drawDogEntity） ================= */
    var dp = DOG_PHASE[dog.phase];
    var dpt = dp ? (dog.phaseT || 0) : 0;
    var dLean = 0, dYOff = 0, dXOff = (dog.knock || 0) + (dog.sway || 0);
    if (dog.phase === 'idle') {
      dYOff = Math.sin(now / 300 + (dog.bob || 0)) * 5;
      dLean = Math.sin(now / 300 + (dog.bob || 0)) * 0.03;
    } else if (dog.phase === 'tell') {
      dLean = -0.1 * dpt; dYOff = -4 * dpt;
    } else if (dog.phase === 'dodge') {
      dXOff += 46 * Math.sin(dpt * Math.PI);
      dLean = -0.22 * Math.sin(dpt * Math.PI);
    } else if (dog.phase === 'hit') {
      dLean = 0.08;
    }
    var koK = dog.phase === 'ko' ? Math.min(dpt * 1.6, 1) : 0;
    var dogRot = dog.phase === 'ko' ? 1.35 * koK : dLean;
    var dogEffX = DOG_X + dXOff;
    var dogY = ground + dYOff;

    var isRage = !!(dog.rage && dog.rage.phase === 'bite');
    var isRageTell = !!(dog.rage && dog.rage.phase === 'tell');
    var wagSpeed = dog.rage ? 55 : (dog.phase === 'dodge' ? 90 : 130);
    var wag = Math.sin(now / wagSpeed) * (dog.rage ? 22 : 12);
    var legEnd1 = dog.phase === 'ko' ? -20 : 96;
    var legEnd2 = dog.phase === 'ko' ? -20 : 96;
    var legEnd3 = dog.phase === 'ko' ? -26 : 94;
    var earRot = dog.rage ? -32 : (dog.phase === 'tell' ? -26 + 6 * (1 - dpt) : -17 + wag * 0.7);

    /* 立绘（当前关卡角色图片）；imgOk=false 时回退代码绘制部件 */
    var lvEntry = (CONFIG.assets && CONFIG.assets.levels) ? CONFIG.assets.levels[levelIdx] : null;
    var portraitOn = imgOk && !!lvEntry;
    var PW = 340, PH = lvEntry ? PW * lvEntry.h / lvEntry.w : 261;
    var portraitBob = dog.phase === 'idle' ? Math.sin(now / 300 + (dog.bob || 0)) * 5 : 0;
    // 立绘矩形（狗根局部坐标：底部贴地、水平居中）
    var portraitStyle = 'left:' + px(-PW / 2 * s) + ';top:' + px((-PH + portraitBob) * s) +
      ';width:' + px(PW * s) + ';height:' + px(PH * s) + ';';
    var flashOpacity = num(Math.max(0, (dog.flash || 0) * 0.5));
    var flashStyle = portraitStyle + 'background:#ffffff;opacity:' + flashOpacity + ';border-radius:' + px(24 * s) + ';';

    var dogVM = {
      root: 'left:' + px(dogEffX * s) + ';top:' + px(dogY * s) +
        ';transform:rotate(' + num(dogRot * 180 / Math.PI) + 'deg);',
      shadow: box(DOG_X + 6 - 120, ground + 10 - 22, 240, 44),
      rage: dog.rage
        ? box(-70, -400, 140, 420, 'background:#ff1744;opacity:' +
          num(isRage ? 0.3 : (isRageTell ? 0.12 + 0.18 * (dog.rage.phaseT || 0) : 0.12)) + ';border-radius:50%;')
        : '',
      /* 立绘本体（image 组件）与受击闪白（叠在立绘上） */
      portrait: portraitOn
        ? { src: lvEntry.src, style: portraitStyle }
        : null,
      flash: portraitOn ? { style: flashStyle } : null,
      /* ---- 以下为代码绘制兜底部件（imgOk=false 时显示） ---- */
      tail: seg(-50, -6, -88, -34 + wag, 16),
      tailTip: dot(-88, -34 + wag, 9),
      legFar1: seg(-30, 26, -32, legEnd1, 16),
      legFar2: seg(26, 26, 30, legEnd2, 16),
      legNear: seg(18, 28, 24, legEnd3, 18),
      body: box(-58, -36, 116, 80),
      belly: box(-26, -4, 68, 44),
      collar: box(26, -34, 36, 50, 'transform:rotate(18deg);'),
      ear: box(19, -106, 30, 60, 'transform:rotate(' + num(earRot) + 'deg);'),
      head: box(16, -88, 84, 84),
      snout: box(69, -45, 50, 34),
      nose: dot(110, -34, 8),
      eyeL: dot(50, -62, 4.5),
      eyeR: dot(80, -60, 4.5),
      eyeHL: dot(51.5, -63.5, 1.5),
      eyeHR: dot(81.5, -61.5, 1.5),
      // X 眼（挨打/倒地）与怒目（反扑）
      xEyeL: dog.phase === 'hit' || dog.phase === 'ko'
        ? box(38, -74, 24, 24, 'font-size:' + px(26 * s) + ';line-height:' + px(24 * s) + ';color:#3b2a16;')
        : '',
      xEyeR: dog.phase === 'hit' || dog.phase === 'ko'
        ? box(68, -72, 24, 24, 'font-size:' + px(26 * s) + ';line-height:' + px(24 * s) + ';color:#3b2a16;')
        : '',
      rageEyeL: isRage || isRageTell
        ? box(44, -74, 24, 24, 'font-size:' + px(24 * s) + ';line-height:' + px(24 * s) + ';color:#3b2a16;')
        : '',
      rageEyeR: isRage || isRageTell
        ? box(74, -72, 24, 24, 'font-size:' + px(24 * s) + ';line-height:' + px(24 * s) + ';color:#3b2a16;')
        : '',
      blush: dot(48, -34, 8),
      mouth: isRage
        ? box(84, -24, 28, 18)
        : (dog.phase === 'hit' || dog.phase === 'ko')
          ? box(84, -24, 26, 18)
          : (dog.phase === 'dodge' || dog.phase === 'tell')
            ? box(82, -22, 26, 12)
            : box(82, -20, 20, 14),
      tongue: (dog.phase === 'hit' || dog.phase === 'ko') ? box(88, -16, 14, 16) : '',
      teeth1: isRage ? dot(90, -24, 3) : '',
      teeth2: isRage ? dot(96, -24, 3) : '',
      teeth3: isRage ? dot(102, -24, 3) : '',
      codeFlash: box(-62, -400, 124, 400, 'opacity:' + flashOpacity + ';'),
      ko: dog.phase === 'ko'
    };

    // KO 转圈星星（3 颗环绕，随立绘高度调整）
    if (dogVM.ko) {
      for (var si = 0; si < 3; si++) {
        var sa = now / 130 + (si * Math.PI * 2) / 3;
        dogVM['koStar' + (si + 1)] = dot(Math.cos(sa) * 46, -PH * 0.62 + Math.sin(sa) * 14, 10);
      }
    } else {
      dogVM.koStar1 = ''; dogVM.koStar2 = ''; dogVM.koStar3 = '';
    }

    // 预警 "!"（闪避黄 / 反扑红），挂在立绘头顶
    var tellScale = 1 + 0.35 * Math.sin((dog.phase === 'tell' ? dpt : (dog.rage ? dog.rage.phaseT || 0 : 0)) * Math.PI);
    var showTell = dog.phase === 'tell' || isRageTell;
    dogVM.tell = showTell
      ? box(-45, -(PH + 60), 90, 90, 'line-height:' + px(90 * s) + ';font-size:' + px(64 * s) +
        ';transform:scale(' + num(tellScale) + ');color:' + (isRageTell ? '#ff5252' : '#ffd54a') + ';')
      : '';

    // 体力条（屏幕绝对坐标，跟随狗的有效 x，挂在立绘头顶）
    var hpRatio = Math.max(0, Math.min(1, (dog.hp || 0) / (dog.maxHp || 1)));
    var hpShow = scene === 'play' && dog.phase !== 'ko';
    var hpBaseY = ground + dYOff - (PH + 90);
    dogVM.hpBg = hpShow ? box(dogEffX - 90, hpBaseY - 3, 180, 24) : '';
    dogVM.hpFill = hpShow
      ? box(dogEffX - 87, hpBaseY, Math.max(8, 174 * hpRatio), 18,
        'background:' + (hpRatio > 0.5 ? '#8bc34a' : (hpRatio > 0.25 ? '#ffb300' : '#ff5252')) + ';border-radius:' + px(9 * s) + ';')
      : '';
    dogVM.hpLabel = hpShow
      ? box(dogEffX - 90, hpBaseY - 38, 180, 28,
        'line-height:' + px(28 * s) + ';font-size:' + px(20 * s) + ';color:#ffffff;')
      : '';
    dogVM.hpText = (lv.targetName || '大黄狗') + ' ' + Math.max(0, Math.ceil(dog.hp || 0));

    /* ================= 人类球员（出脚方，公式对应 drawHumanEntity） ================= */
    var hp = HUMAN_PHASE[human.phase];
    var hpt = hp ? (human.phaseT || 0) : 0;
    var crouch = 0, lunge = 0, ext = 0, tilt = 0;
    if (human.phase === 'windup') {
      crouch = hpt; tilt = -0.07 * hpt;
    } else if (human.phase === 'kick') {
      var kp = hpt;
      lunge = kp < 0.55 ? kp / 0.55 : 1 - (kp - 0.55) / 0.45 * 0.35;
      ext = kp < 0.35 ? kp / 0.35 : (kp < 0.7 ? 1 : 1 - (kp - 0.7) / 0.3);
      tilt = 0.12 * ext;
    } else if (human.phase === 'recover') {
      lunge = 0.65 * (1 - hpt); crouch = 0.3 * (1 - hpt);
    }
    var hBob = human.phase === 'idle' ? Math.sin(now / 260) * 6 : 0;
    var hHop = human.phase === 'cheer' ? -Math.abs(Math.sin(now / 110)) * 30 : 0;
    var humanX = HUMAN_X + lunge * 150;
    var humanY = ground + hBob + hHop;

    var armSwing = human.phase === 'kick' ? 40 : (human.phase === 'windup' ? -30 : 0);
    var cheerLift = human.phase === 'cheer' ? 60 : 0;
    var kickFx = 24 + ext * 170, kickFy = 24 - ext * 92;

    var humanVM = {
      root: 'left:' + px(humanX * s) + ';top:' + px(humanY * s) +
        ';transform:rotate(' + num(tilt * 180 / Math.PI) + 'deg);',
      shadow: box(HUMAN_X - 80, ground + 8 - 17, 160, 34),
      legFarSkin: seg(12, -95, 14, -38, 15),
      sockFar: seg(14, -38, 12, -10, 18),
      shoeFar: box(0, -16, 30, 16),
      legNearSkin: seg(-12, -95, -14, -38, 16),
      sockNear: seg(-14, -38, -12, -10, 19),
      shoeNear: box(-30, -16, 30, 16),
      shorts: box(-42, -152, 84, 60),
      armFar: seg(36, -250, 54 + armSwing * 0.5, -196 + armSwing - cheerLift, 13),
      armNear: seg(-36, -250, -56 - armSwing * 0.5, -200 + armSwing - cheerLift, 14),
      jersey: box(-48, -268, 96, 122),
      stripe: box(-48, -268, 16, 122),
      collar: box(-16, -268, 32, 14),
      num: box(-46, -252, 92, 56, 'line-height:' + px(56 * s) + ';font-size:' + px(44 * s) + ';'),
      head: box(-38, -350, 76, 76),
      hair: box(-39, -353, 78, 40),
      earL: dot(-38, -308, 8),
      earR: dot(38, -308, 8),
      eyeL: dot(-16, -318, 4.5),
      eyeR: dot(14, -318, 4.5),
      eyeHL: dot(-14.5, -319.5, 1.5),
      eyeHR: dot(15.5, -319.5, 1.5),
      mouth: (human.phase === 'kick' || human.phase === 'cheer')
        ? box(-11, -310, 22, 18)
        : box(-11, -308, 22, 12),
      tongue: human.phase === 'cheer' ? box(-6, -302, 12, 8) : '',
      kickLeg: ext > 0 ? seg(24, 24, kickFx, kickFy, 20) : '',
      kickSock: ext > 0 ? seg(kickFx - 14, kickFy + 12, kickFx + 6, kickFy + 2, 20) : '',
      kickShoe: ext > 0 ? box(kickFx - 6, kickFy - 14, 34, 18) : ''
    };

    /* ================= 粒子 / 飘字 / 横幅 ================= */
    var particles = [];
    var plist = S.particles || [];
    for (var i = 0; i < plist.length && i < 60; i++) {
      var pt = plist[i];
      var alpha = 1 - (pt.age || 0) / (pt.life || 1);
      particles.push({
        i: i,
        st: box(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size,
          'background:' + pt.color + ';opacity:' + num(Math.max(0, alpha)) +
          ';transform:rotate(' + num((pt.rot || 0) * 180 / Math.PI) + 'deg);')
      });
    }
    var floaters = [];
    var flist = S.floaters || [];
    for (var j = 0; j < flist.length && j < 12; j++) {
      var f = flist[j];
      var fa = 1 - (f.age || 0) / (f.life || 1);
      floaters.push({
        i: j,
        t: f.text,
        st: box(f.x - 110, f.y - (f.size || 40) / 2, 220, (f.size || 40) + 8,
          'color:' + f.color + ';font-size:' + px((f.size || 40) * s) +
          ';opacity:' + num(Math.max(0, fa)) + ';line-height:' + px(((f.size || 40) + 8) * s) + ';')
      });
    }
    var banner = null;
    if (S.banner) {
      var bAge = now - (S.banner.at || 0);
      var bT = bAge / (S.banner.dur || 900);
      var bAlpha = bT < 0.15 ? bT / 0.15 : Math.max(0, 1 - (bT - 0.15) / 0.85);
      var bScale = 1 + 0.25 * (1 - Math.min(bAge / 180, 1));
      banner = {
        t: S.banner.text,
        c: S.banner.color,
        st: 'opacity:' + num(Math.max(0, bAlpha)) +
          ';transform:translateX(-50%) scale(' + num(bScale) + ');' +
          ';font-size:' + px(72 * s) + ';'
      };
    }

    /* ================= HUD ================= */
    var levelTime = lv.time || 45;
    var timeLeft = Math.max(0, S.timeLeft || 0);
    var timePct = Math.max(0, Math.min(100, timeLeft / levelTime * 100));
    var timerColor = timePct > 50 ? '#7cff6b' : (timePct > 20 ? '#ffd54a' : '#ff5252');
    var combo = S.combo || 0;
    var cap = CONFIG.comboBonusCap || 20;
    var per = CONFIG.comboBonusPer || 0.05;
    var comboBonus = Math.round(Math.min(Math.max(combo - 1, 0), cap) * per * 100);
    var levelShort = (lv.name || '关卡').split('·')[1] ? lv.name.split('·')[1].trim() : lv.name;

    var hud = {
      score: '' + (S.score || 0),
      best: '' + (S.best || 0),
      levelChip: '第 ' + (levelIdx + 1) + ' 关/' + levels.length + ' · ' + levelShort,
      timeText: Math.ceil(timeLeft) + 's',
      timePct: num(timePct),
      timerColor: timerColor,
      combo: combo >= 2 ? combo + ' 连击' : '',
      comboBonus: combo >= 2 ? '伤害 +' + comboBonus + '%' : '',
      goalText: (lv.koGoal && scene === 'play')
        ? 'KO 目标 ' + Math.min(S.koCount || 0, lv.koGoal) + ' / ' + lv.koGoal
        : ''
    };

    /* ================= 遮罩 ================= */
    var overlay = null;
    var ctaOp = num(0.6 + 0.4 * Math.sin(now / 300));
    var achCfg = (CONFIG.achievements && CONFIG.achievements.dogmaster) || { name: '打狗大师', desc: '三关全部打完' };
    var achGot = !!(S.achievements && S.achievements.dogmaster);
    if (scene === 'menu') {
      overlay = {
        kind: 'menu',
        title: '暴击大黄狗',
        sub: '操控球员，飞踹三关狗仔！',
        best: '历史最高：' + (S.best || 0),
        cards: levels.map(function (l) {
          var meta = (l.time || 45) + '秒';
          if (l.koGoal) meta += ' · KO×' + l.koGoal;
          return {
            name: l.name,
            desc: l.desc || '',
            meta: meta
          };
        }),
        ach: {
          got: achGot,
          name: achCfg.name,
          desc: achCfg.desc
        },
        cta: '点击屏幕  开始游戏',
        ctaOpacity: ctaOp,
        tips: ['点击出脚 · 连击提升伤害 · 狗仔会闪避', '三关连打拿「打狗大师」，把截图甩群里比个分'],
        fine: ['抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗。',
          '适度游戏益脑，沉迷游戏伤身。合理安排时间，享受健康生活。',
          '适龄提示：8+  游戏角色仅供娱乐，请勿模仿']
      };
    } else if (scene === 'levelIntro') {
      var rows = [
        { k: '限时', v: (lv.time || 45) + ' 秒' },
        { k: '目标体力', v: '' + (lv.hp || 100) },
        { k: '闪避率', v: Math.round((lv.dodgeBase || 0) * 100) + '%' },
        { k: 'KO 奖励', v: '+' + (lv.koBonus || 150) + ' 分' }
      ];
      if (lv.koGoal) rows.push({ k: '通关目标', v: 'KO ' + lv.koGoal + ' 次' });
      overlay = {
        kind: 'levelIntro',
        levelNo: '第 ' + (levelIdx + 1) + ' 关 / ' + levels.length,
        name: levelShort,
        desc: lv.desc || '',
        rows: rows,
        mechanicTip: lv.mechanicTip || '',
        cta: '点击屏幕  开始本关',
        ctaOpacity: ctaOp
      };
    } else if (scene === 'levelClear') {
      var st = (S.levelStats && S.levelStats[levelIdx]) || { ko: 0, maxCombo: 0, goalDone: false };
      var nextLv = levels[levelIdx + 1] || {};
      var nextShort = (nextLv.name || '').split('·')[1] ? nextLv.name.split('·')[1].trim() : (nextLv.name || '');
      overlay = {
        kind: 'levelClear',
        title: st.goalDone ? '过关！' : '时间到！',
        sub: '第 ' + (levelIdx + 1) + ' 关 · ' + levelShort + (st.goalDone ? ' 目标达成' : ' 未达成 KO 目标'),
        score: '' + (S.score || 0),
        stat: 'KO ' + (st.ko || 0) + ' 次 · 最高 ' + (st.maxCombo || 0) + ' 连击',
        earlyBonus: (S.earlyBonus || 0) > 0 ? '提前通关奖励 +' + S.earlyBonus : '',
        totalScore: '累计总分：' + (S.totalScore || 0),
        cta: '点击进入  第 ' + (levelIdx + 2) + ' 关 · ' + nextShort,
        ctaOpacity: ctaOp
      };
    } else if (scene === 'finalResult') {
      var totalKo = 0;
      var rows2 = levels.map(function (l, i) {
        var s2 = (S.levelStats && S.levelStats[i]) || { ko: 0, maxCombo: 0 };
        totalKo += s2.ko || 0;
        return { name: l.name, score: '' + ((S.levelScores && S.levelScores[i]) || 0) };
      });
      overlay = {
        kind: 'final',
        title: S.finalReason === 'clear' ? '全部通关！' : '游戏结束！',
        score: '' + (S.totalScore || 0),
        newBest: !!S.newBest,
        best: '历史最高：' + (S.best || 0),
        rows: rows2,
        stat: '共 KO ' + totalKo + ' 次 · 最高 ' + (S.maxCombo || 0) + ' 连击',
        ach: {
          got: true,
          justUnlocked: S.achUnlocked === 'dogmaster',
          name: achCfg.name,
          desc: achCfg.desc
        },
        cta: '点击屏幕  返回菜单',
        ctaOpacity: ctaOp
      };
    } else if (S.paused) {
      overlay = { kind: 'paused', title: '游戏已暂停', sub: '回到微信自动继续' };
    }

    /* ================= 抖屏 / 白闪 ================= */
    var shake = S.shake || 0;
    var shakeStyle = shake > 0.5
      ? 'transform:translate(' + px((Math.random() * 2 - 1) * shake * 0.5) + ',' +
        px((Math.random() * 2 - 1) * shake * 0.5) + ');'
      : '';

    return {
      scene: scene,
      targetName: lv.targetName || '大黄狗',
      playerNum: '7',
      bgSrc: (CONFIG.assets && CONFIG.assets.bg) || '',
      circle: box(DW / 2 - 330, ground - 210 - 180, 660, 360),
      line: box(0, ground + 2 - 4, DW, 8),
      human: humanVM,
      dog: dogVM,
      particles: particles,
      floaters: floaters,
      banner: banner,
      flash: Math.min(0.85, S.flash || 0),
      shakeStyle: shakeStyle,
      hud: hud,
      overlay: overlay
    };
  }

  /* ---------- 立绘布局（微信 canvas 通道专用：驱动 WXML 立绘图片层） ----------
   * 旧版画布不支持 drawImage，立绘本体放在 canvas 上层的 <image> 里，
   * 本函数把 core 的游戏状态翻译成该 image 的样式（与 canvas drawPortrait 公式一致）。
   * 返回 { src, show, style, flashStyle }；show=false 表示该关立绘未就绪（隐藏，走代码绘制兜底）。
   */
  function portraitLayout(game, vw, vh, CONFIG) {
    var dbg = (game && game.debug) || {};
    var S = dbg.S || {};
    var dog = dbg.dog || { phase: 'idle', phaseT: 0, x: DOG_X, knock: 0, sway: 0 };
    var portraitOk = dbg.portraitOk || [];
    CONFIG = CONFIG || {};
    var s = (vw && vw > 0) ? vw / DW : 1;
    var DH = (vh && vh > 0) ? vh / s : 1334;
    var ground = DH * GROUND_RATIO;
    var now = S.now || 0;
    var levelIdx = Math.max(0, Math.min(S.level || 0, ((CONFIG.assets && CONFIG.assets.levels) || []).length - 1));
    var entry = (CONFIG.assets && CONFIG.assets.levels) ? CONFIG.assets.levels[levelIdx] : null;
    var ok = !!entry && !!portraitOk[levelIdx];
    if (!ok || !entry) return { src: '', show: false, style: '', flashStyle: '' };

    var p = dog.phaseT || 0;
    var dYOff = 0, dXOff = (dog.knock || 0) + (dog.sway || 0);
    if (dog.phase === 'idle') dYOff = Math.sin(now / 300 + (dog.bob || 0)) * 5;
    else if (dog.phase === 'tell') dYOff = -4 * p;
    else if (dog.phase === 'dodge') { dXOff += 46 * Math.sin(p * Math.PI); }
    var koK = dog.phase === 'ko' ? Math.min(p * 1.6, 1) : 0;
    var rot = dog.phase === 'ko' ? 1.35 * koK : (dog.phase === 'dodge' ? -0.22 * Math.sin(p * Math.PI) : (dog.phase === 'tell' ? -0.1 * p : (dog.phase === 'hit' ? 0.08 : Math.sin(now / 300 + (dog.bob || 0)) * 0.03)));
    var PW = 340, PH = PW * entry.h / entry.w;
    var bob = dog.phase === 'idle' ? Math.sin(now / 300 + (dog.bob || 0)) * 5 : 0;
    var cx = (DOG_X + dXOff) * s;
    var bottom = (ground + dYOff + bob) * s;
    var style = 'left:' + px(cx - PW * s / 2) + ';top:' + px(bottom - PH * s) +
      ';width:' + px(PW * s) + ';height:' + px(PH * s) +
      ';transform:rotate(' + num(rot * 180 / Math.PI) + 'deg);transform-origin:50% 100%;';
    var flashStyle = style + 'background:#ffffff;opacity:' + num(Math.max(0, (dog.flash || 0) * 0.5)) + ';';
    return { src: entry.src, show: true, style: style, flashStyle: flashStyle };
  }

  /* ---------- 30fps setData 驱动 ---------- */
  function start(game, page, vw, vh, CONFIG, getImgOk) {
    var timer = 0;
    var errors = 0;
    var stopped = false;
    function tick() {
      if (stopped) return;
      var vm = null;
      try {
        var ok = getImgOk ? getImgOk() : true;
        vm = buildViewModel(game, vw, vh, CONFIG, ok);
        errors = 0;
      } catch (e) {
        errors++;
        if (errors <= 1 && page && page.setData) {
          page.setData({ canvasError: '组件渲染异常：' + (e && e.message ? e.message : e) });
        }
        if (errors > 10) { stopped = true; return; }
      }
      if (vm && page && page.setData) {
        page.setData({ pv: vm });
      }
      timer = setTimeout(tick, 33);
    }
    tick();
    return {
      stop: function () {
        stopped = true;
        if (timer) clearTimeout(timer);
      }
    };
  }

  return {
    createNoopCtx: createNoopCtx,
    buildViewModel: buildViewModel,
    portraitLayout: portraitLayout,
    start: start
  };
});
