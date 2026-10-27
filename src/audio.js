/* ============================================================
 * 合成音效：不依赖任何音频素材文件
 * 微信（wx.createWebAudioContext）与浏览器（AudioContext）双端可用
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaojiAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create() {
    var ac = null;
    var enabled = true;

    function ctx() {
      if (ac) return ac;
      try {
        if (typeof wx !== 'undefined' && wx.createWebAudioContext) {
          ac = wx.createWebAudioContext();
        } else if (typeof window !== 'undefined') {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (AC) ac = new AC();
        }
      } catch (e) {
        ac = null;
      }
      return ac;
    }

    // 首次用户手势时调用，解锁音频上下文
    function resume() {
      var c = ctx();
      if (c && c.resume) {
        try { c.resume(); } catch (e) {}
      }
    }

    function tone(freq, dur, type, vol, delay, slideTo) {
      var c = ctx();
      if (!c || !enabled) return;
      try {
        var t0 = c.currentTime + (delay || 0);
        var o = c.createOscillator();
        var g = c.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(freq, t0);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g);
        g.connect(c.destination);
        o.start(t0);
        o.stop(t0 + dur + 0.02);
      } catch (e) {}
    }

    function noise(dur, vol, delay, lowpass) {
      var c = ctx();
      if (!c || !enabled) return;
      try {
        var t0 = c.currentTime + (delay || 0);
        var len = Math.max(1, Math.floor(c.sampleRate * dur));
        var buf = c.createBuffer(1, len, c.sampleRate);
        var data = buf.getChannelData(0);
        for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        var src = c.createBufferSource();
        src.buffer = buf;
        var g = c.createGain();
        g.gain.setValueAtTime(vol || 0.3, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        var node = src;
        if (lowpass) {
          var f = c.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = lowpass;
          src.connect(f);
          node = f;
        }
        node.connect(g);
        g.connect(c.destination);
        src.start(t0);
        src.stop(t0 + dur);
      } catch (e) {}
    }

    var SFX = {
      kick: function () {
        noise(0.09, 0.5, 0, 900);
        tone(140, 0.14, 'sine', 0.5, 0, 50);
      },
      crit: function () {
        tone(660, 0.07, 'square', 0.2);
        tone(880, 0.07, 'square', 0.2, 0.06);
        tone(1320, 0.12, 'square', 0.24, 0.12);
        noise(0.06, 0.25, 0, 2000);
      },
      mega: function () {
        var notes = [523, 659, 784, 1046, 1318];
        notes.forEach(function (f, i) { tone(f, 0.12, 'square', 0.18, i * 0.06); });
        noise(0.12, 0.35, 0, 3000);
      },
      dodge: function () {
        tone(700, 0.16, 'sawtooth', 0.12, 0, 180);
      },
      ko: function () {
        var notes = [392, 523, 659, 784];
        notes.forEach(function (f, i) { tone(f, 0.16, 'triangle', 0.24, i * 0.09); });
      },
      counter: function () {
        // 被反咬：低沉咆哮 + 杂音
        tone(120, 0.22, 'sawtooth', 0.3, 0, 60);
        noise(0.14, 0.4, 0, 500);
      },
      levelclear: function () {
        // 过关：上行琶音
        var notes = [523, 659, 784, 1046];
        notes.forEach(function (f, i) { tone(f, 0.14, 'triangle', 0.22, i * 0.08); });
      },
      tick: function () {
        tone(1050, 0.05, 'square', 0.12);
      },
      start: function () {
        tone(392, 0.08, 'triangle', 0.22);
        tone(523, 0.08, 'triangle', 0.22, 0.08);
        tone(659, 0.12, 'triangle', 0.22, 0.16);
      }
    };

    return {
      resume: resume,
      setEnabled: function (v) { enabled = !!v; },
      play: function (name) {
        if (!enabled) return;
        var fn = SFX[name];
        if (!fn) return;
        try {
          resume();
          fn();
        } catch (e) {}
      }
    };
  }

  return { create: create };
});
