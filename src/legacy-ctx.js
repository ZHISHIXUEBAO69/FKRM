/* ============================================================
 * 微信旧版 CanvasContext 适配器（加固版）
 * 旧版画布（canvas-id + wx.createCanvasContext）是"方法式"API：
 *   setFillStyle / setFontSize / setGlobalAlpha / setTextAlign ...
 * 而 core.js 用浏览器风格"属性式"写法：ctx.fillStyle = ...
 * 本模块做一层翻译，并对旧版画布**可能缺失的能力**全部兜底：
 *   - ellipse 缺失 → save/translate/rotate/scale + arc 模拟
 *   - setTransform 缺失 → save + translate + scale 模拟（flush 时复位）
 *   - createRadialGradient 缺失 → createCircularGradient 近似
 *   - 任何方法/渐变缺失 → no-op 兜底（绝不让渲染循环崩掉变成绿屏）
 *   - 每帧结束必须 flush() -> raw.draw(true) 才会上屏
 * 同时提供 sysInfo：系统信息读取（同步优先 / 异步兜底 / 默认值）
 * 小程序页面与 Node 冒烟测试共用本文件
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaojiLegacyCtx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SETTERS = {
    fillStyle: 'setFillStyle',
    strokeStyle: 'setStrokeStyle',
    lineWidth: 'setLineWidth',
    lineCap: 'setLineCap',
    lineJoin: 'setLineJoin',
    miterLimit: 'setMiterLimit',
    globalAlpha: 'setGlobalAlpha',
    textAlign: 'setTextAlign',
    textBaseline: 'setTextBaseline',
    shadowColor: 'setShadowColor',
    shadowBlur: 'setShadowBlur',
    shadowOffsetX: 'setShadowOffsetX',
    shadowOffsetY: 'setShadowOffsetY'
  };
  var METHODS = [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'arcTo', 'rect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo',
    'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect',
    'fillText', 'strokeText', 'translate', 'rotate', 'scale', 'clip',
    'setLineDash', 'measureText'
  ];

  /**
   * 把微信旧版 CanvasContext 包装成浏览器风格的 2D context
   * @param {Object} raw wx.createCanvasContext 返回的对象
   * @returns {Object} 带 flush() 的类原生 context（缺失能力全部兜底）
   */
  function createLegacyCtx(raw) {
    var ctx = {};
    var hasNativeSetTransform = (typeof raw.setTransform === 'function');

    METHODS.forEach(function (name) {
      if (typeof raw[name] === 'function') {
        ctx[name] = function () { return raw[name].apply(raw, arguments); };
        return;
      }
      // ---- 缺失方法兜底：绝不让渲染循环崩掉 ----
      if (name === 'ellipse') {
        // 用 save/translate/rotate/scale + arc 模拟椭圆
        ctx.ellipse = function (x, y, rx, ry, rotation, startAngle, endAngle, ccw) {
          var ry2 = Math.max(ry, 0.01);
          raw.save();
          raw.translate(x, y);
          if (rotation) raw.rotate(rotation);
          if (rx !== ry) raw.scale(rx / ry2, 1);
          raw.arc(0, 0, ry2, startAngle, endAngle, ccw);
          raw.restore();
        };
      } else if (name === 'measureText') {
        ctx.measureText = function () { return { width: 0 }; };
      } else {
        ctx[name] = function () {};   // no-op 兜底
      }
    });

    // 属性写法 -> 旧版方法调用（方法缺失时静默忽略，不抛异常）
    Object.keys(SETTERS).forEach(function (prop) {
      var method = SETTERS[prop];
      if (typeof raw[method] !== 'function') return;
      Object.defineProperty(ctx, prop, {
        set: function (v) { raw[method](v); },
        get: function () { return undefined; }
      });
    });

    // font 只取字号（旧版画布无加粗概念）
    if (typeof raw.setFontSize === 'function') {
      Object.defineProperty(ctx, 'font', {
        set: function (v) {
          var m = /(\d+(?:\.\d+)?)px/.exec(String(v));
          if (m) raw.setFontSize(parseFloat(m[1]));
        },
        get: function () { return ''; }
      });
    }

    // 渐变（缺失时返回带 addColorStop 的桩，fillStyle 赋值不炸）
    var gradStub = function () { return { addColorStop: function () {} }; };
    if (typeof raw.createLinearGradient === 'function') {
      ctx.createLinearGradient = function () {
        return raw.createLinearGradient.apply(raw, arguments);
      };
    } else {
      ctx.createLinearGradient = gradStub;
    }
    if (typeof raw.createRadialGradient === 'function') {
      ctx.createRadialGradient = function () {
        return raw.createRadialGradient.apply(raw, arguments);
      };
    } else if (typeof raw.createCircularGradient === 'function') {
      // 旧版只有圆形渐变：取双圆心中点 + 平均半径近似径向渐变
      ctx.createRadialGradient = function (x0, y0, r0, x1, y1, r1) {
        return raw.createCircularGradient((x0 + x1) / 2, (y0 + y1) / 2, (r0 + r1) / 2);
      };
    } else {
      ctx.createRadialGradient = gradStub;
    }
    if (typeof raw.createCircularGradient === 'function') {
      ctx.createCircularGradient = function () {
        return raw.createCircularGradient.apply(raw, arguments);
      };
    } else {
      ctx.createCircularGradient = gradStub;
    }

    // setTransform：优先透传；旧版没有时用 save+translate+scale 模拟，
    // 配合 flush 里的复位保持栈平衡（core 每帧只会以相同参数重置变换）
    var transformPushed = false;
    ctx.setTransform = function (a, b, c, d, e, f) {
      if (hasNativeSetTransform) { raw.setTransform(a, b, c, d, e, f); return; }
      if (transformPushed) { raw.restore(); transformPushed = false; }
      raw.save();
      raw.translate(e, f);
      raw.scale(a, d);
      transformPushed = true;
    };

    // 每帧提交：旧版画布必须显式 draw 才会上屏（draw 缺失时静默跳过）
    ctx.flush = function () {
      if (typeof raw.draw === 'function') raw.draw(true);
      if (transformPushed && !hasNativeSetTransform) {
        raw.restore();
        transformPushed = false;
      }
    };

    return ctx;
  }

  /* 系统信息：同步优先，异步兜底，再不行给默认值 */
  function sysInfo(cb) {
    var hasWx = (typeof wx !== 'undefined');
    try {
      if (hasWx && typeof wx.getSystemInfoSync === 'function') {
        cb(wx.getSystemInfoSync() || {});
        return;
      }
    } catch (e) {}
    if (hasWx && typeof wx.getSystemInfo === 'function') {
      try {
        wx.getSystemInfo({
          success: function (s) { cb(s || {}); },
          fail: function () { cb({}); }
        });
        return;
      }
      catch (e) {}
    }
    cb({});
  }

  return { createLegacyCtx: createLegacyCtx, sysInfo: sysInfo };
});
