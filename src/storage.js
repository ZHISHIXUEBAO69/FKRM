/* ============================================================
 * 本地存储：最高分持久化
 * 微信（wx.setStorageSync）与浏览器（localStorage）双端可用
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaojiStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function get(key, dflt) {
    try {
      if (typeof wx !== 'undefined' && wx.getStorageSync) {
        var v = wx.getStorageSync(key);
        return (v === '' || v === undefined || v === null) ? dflt : v;
      }
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem(key);
        return raw === null ? dflt : JSON.parse(raw);
      }
    } catch (e) {}
    return dflt;
  }

  function set(key, val) {
    try {
      if (typeof wx !== 'undefined' && wx.setStorageSync) {
        wx.setStorageSync(key, val);
        return;
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(val));
      }
    } catch (e) {}
  }

  return { get: get, set: set };
});
