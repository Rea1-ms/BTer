// ==UserScript==
// @name         B站评论一键@（自动选择 / 多分组 / 中奖楼 / 绑定楼 / 页面钩子）
// @namespace    https://tampermonkey.net/
// @version      4.2
// @description  一键@：自动选择模式（默认）—若URL含#reply或你刚回过某楼则在该楼中楼发送，否则回退中奖楼；支持多分组、顶层直发、占楼→延迟→楼中楼@（含重试）、页面钩子仅拦截 reply/add 参数；rpid临时保存，用完即丢、刷新即清。每条最多@10人，自动分片。
// @author       GPT-5 Pro & Gemini-2.5 Pro & User
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      api.bilibili.com
// @run-at       document-idle
// ==/UserScript==

/* eslint-env browser, es2020 */
/* global GM_xmlhttpRequest, GM_cookie, GM_notification, GM_addStyle, GM_setValue, GM_getValue, GM_registerMenuCommand, GM_setClipboard, GM_unregisterMenuCommand */

(function () {
  "use strict";

  // ========= 常量 & 键名 =========
  const AT_LIMIT_PER_COMMENT = 10;

  // 设置 / 模式
  const GM_KEY_SESSDATA = "BILI_SESSDATA";
  const GM_KEY_MODE = "BILI_AT_REPLY_MODE";          // 手动模式：'top'|'threadSelf'|'threadBind'
  const GM_KEY_AUTO_MODE = "BILI_AT_AUTO_MODE";      // 自动选择模式 开/关（默认true）
  const GM_KEY_THREAD_PREFIX = "BILI_AT_THREAD_PREFIX";
  const GM_KEY_THREAD_DELAY_MS = "BILI_AT_THREAD_DELAY_MS";
  const GM_KEY_RETRY_TIMES = "BILI_AT_RETRY_TIMES";
  const GM_KEY_RETRY_BASE_MS = "BILI_AT_RETRY_BASE_MS";
  const GM_KEY_HOOK_ENABLED = "BILI_AT_ENABLE_PAGE_HOOK"; // 页面钩子默认true

  // 分组
  const GM_KEY_GROUPS = "BILI_AT_GROUPS";              // { [groupName]: string[] }
  const GM_KEY_GROUP_ORDER = "BILI_AT_GROUP_ORDER";    // string[]
  const GM_KEY_ACTIVE_GROUPS = "BILI_AT_ACTIVE_GROUPS";// string[]
  const GM_KEY_DEDUP = "BILI_AT_DEDUP";                // boolean

  const ReplyMode = { TOP: "top", THREAD_SELF: "threadSelf", THREAD_BIND: "threadBind" };

  // ========= 初始化（默认） =========
  if (!GM_getValue(GM_KEY_MODE)) GM_setValue(GM_KEY_MODE, ReplyMode.THREAD_SELF); // 手动默认=中奖楼
  if (GM_getValue(GM_KEY_AUTO_MODE) == null) GM_setValue(GM_KEY_AUTO_MODE, true); // 自动开启
  if (!GM_getValue(GM_KEY_THREAD_PREFIX)) GM_setValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
  if (GM_getValue(GM_KEY_THREAD_DELAY_MS) == null) GM_setValue(GM_KEY_THREAD_DELAY_MS, 2500);
  if (GM_getValue(GM_KEY_RETRY_TIMES) == null) GM_setValue(GM_KEY_RETRY_TIMES, 3);
  if (GM_getValue(GM_KEY_RETRY_BASE_MS) == null) GM_setValue(GM_KEY_RETRY_BASE_MS, 1200);
  if (GM_getValue(GM_KEY_HOOK_ENABLED) == null) GM_setValue(GM_KEY_HOOK_ENABLED, true);
  if (!GM_getValue(GM_KEY_GROUPS)) GM_setValue(GM_KEY_GROUPS, {});
  if (!GM_getValue(GM_KEY_GROUP_ORDER)) GM_setValue(GM_KEY_GROUP_ORDER, []);
  if (GM_getValue(GM_KEY_DEDUP) == null) GM_setValue(GM_KEY_DEDUP, true);
  if (!GM_getValue(GM_KEY_ACTIVE_GROUPS)) GM_setValue(GM_KEY_ACTIVE_GROUPS, []); // 初始未选择

  // ========= rpid：仅会话内临时保存（用完即丢）=========
  let sessionBind = { rpid: null, source: null }; // source='url'|'hook'

  function setSessionBind(rpid, source) {
    sessionBind = { rpid: Number(rpid) || null, source: source || null };
  }
  function clearSessionBind() {
    sessionBind = { rpid: null, source: null };
  }

  // ========= 菜单（动态标签，支持刷新）=========
  let menuIds = [];
  function registerMenu() {
    // 尝试清理旧菜单（若环境支持）
    if (typeof GM_unregisterMenuCommand === "function" && Array.isArray(menuIds)) {
      for (const id of menuIds) { try { GM_unregisterMenuCommand(id); } catch (_) {} }
      menuIds = [];
    }

    const selNames = GM_getValue(GM_KEY_ACTIVE_GROUPS, []);
    const selPreview = selNames.length > 3 ? `${selNames.slice(0,3).join(", ")} +${selNames.length-3}` : (selNames.join(", ") || "（未选择）");
    const previewUsers = (() => {
      try {
        const users = aggregateSelectedUsernames({ silentIfEmpty: true });
        return users.slice(0, 3).map(n => `@${n}`).join(" ") || "（空）";
      } catch { return "（空）"; }
    })();
    const autoOn = !!GM_getValue(GM_KEY_AUTO_MODE, true);
    const manualMode = GM_getValue(GM_KEY_MODE, ReplyMode.THREAD_SELF);
    const hookOn = !!GM_getValue(GM_KEY_HOOK_ENABLED, true);
    const dedupOn = !!GM_getValue(GM_KEY_DEDUP, true);

    menuIds.push(GM_registerMenuCommand("1. 设置SESSDATA", setupSessdata));
    menuIds.push(GM_registerMenuCommand("2. 分组中心：新增 / 编辑 / 删除 / 重命名 / 排序", groupsManageCenter));
    menuIds.push(GM_registerMenuCommand(`3. 分组：选择当前使用（可多选） 〔当前：${selPreview}〕`, groupsSelectActive));
    menuIds.push(GM_registerMenuCommand(`4. 分组：预览当前选择名单 〔前3：${previewUsers}〕`, groupsPreviewActive));
    menuIds.push(GM_registerMenuCommand("5. 分组：导入 / 导出（JSON）", groupsImportExport));
    menuIds.push(GM_registerMenuCommand(`6. 分组：去重开关（当前：${dedupOn ? "开" : "关"}）`, toggleDedup));
    menuIds.push(GM_registerMenuCommand(`7. 模式：自动选择（当前：${autoOn ? "开" : "关"}）`, toggleAutoMode));
    menuIds.push(GM_registerMenuCommand(`8. 模式（手动）：切换（当前：${manualMode === "top" ? "顶层直发" : manualMode === "threadSelf" ? "楼中楼-中奖楼" : "绑定楼"}）`, switchManualMode));
    menuIds.push(GM_registerMenuCommand("9. 中奖楼：占楼文案 / 延迟 / 重试设置", setupThreadConfig));
    menuIds.push(GM_registerMenuCommand(`10. 页面钩子：启 / 停（当前：${hookOn ? "开" : "关"}）`, togglePageHook));
    menuIds.push(GM_registerMenuCommand("11. 立即执行一键@（按当前模式+分组）", () => routeSend({ source: "menu" })));
  }
  registerMenu();

  // ========= 工具 =========
  function setupSessdata() {
    const cur = GM_getValue(GM_KEY_SESSDATA, "");
    const val = prompt("请输入 SESSDATA（从浏览器开发者工具 Cookie 面板复制）", cur);
    if (val !== null) {
      GM_setValue(GM_KEY_SESSDATA, val.trim());
      alert(val.trim() ? "SESSDATA 已保存" : "SESSDATA 已清空");
    }
    registerMenu();
  }

  function parseAtList(str) {
    if (!str) return [];
    const s = String(str).trim();
    let list = Array.from(s.matchAll(/@([^@\s]+(?:\s*[^@\s]+)*)/g), (m) => m[1].trim()).filter(Boolean);
    if (list.length === 0) list = s.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    return list.map((n) => n.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").trim()).filter(Boolean);
  }

  function chunkBy(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withRetry(taskFn, { retries = 3, baseDelay = 1200, factor = 1.8 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try { return await taskFn(i); }
      catch (e) { lastErr = e; if (i === retries) break; await sleep(Math.round(baseDelay * Math.pow(factor, i))); }
    }
    throw lastErr;
  }

  function isNonPunctuation(str) {
    if (!str) return false;
    const onlyPunct = /^[\p{P}\p{S}\s]+$/u;
    return !onlyPunct.test(str);
  }

  // ========= 分组数据层 =========
  const getGroupsObj = () => GM_getValue(GM_KEY_GROUPS, {});
  const getGroupOrder = () => GM_getValue(GM_KEY_GROUP_ORDER, []);
  const setGroupsObj = (obj) => GM_setValue(GM_KEY_GROUPS, obj);
  const setGroupOrder = (order) => GM_setValue(GM_KEY_GROUP_ORDER, order);

  function addOrUpdateGroup(name, usernames) {
    name = String(name).trim();
    if (!name) throw new Error("分组名不能为空");
    const groups = getGroupsObj();
    const order = getGroupOrder();
    groups[name] = Array.from(usernames || []);
    if (!order.includes(name)) order.push(name);
    setGroupsObj(groups); setGroupOrder(order);
  }

  function deleteGroup(name) {
    const groups = getGroupsObj();
    const order = getGroupOrder();
    if (!groups[name]) return;
    delete groups[name];
    setGroupsObj(groups);
    setGroupOrder(order.filter((n) => n !== name));
    const act = new Set(GM_getValue(GM_KEY_ACTIVE_GROUPS, []));
    if (act.has(name)) {
      act.delete(name);
      GM_setValue(GM_KEY_ACTIVE_GROUPS, Array.from(act));
    }
  }

  function renameGroup(oldName, newName) {
    const groups = getGroupsObj();
    const order = getGroupOrder();
    if (!groups[oldName]) throw new Error("原分组不存在");
    if (groups[newName]) throw new Error("新分组名已存在");
    groups[newName] = groups[oldName];
    delete groups[oldName];
    setGroupsObj(groups);
    setGroupOrder(order.map((n) => (n === oldName ? newName : n)));
    const act = GM_getValue(GM_KEY_ACTIVE_GROUPS, []);
    GM_setValue(GM_KEY_ACTIVE_GROUPS, act.map((n) => (n === oldName ? newName : n)));
  }

  function listGroupsWithCounts() {
    const groups = getGroupsObj();
    const order = getGroupOrder();
    const active = new Set(GM_getValue(GM_KEY_ACTIVE_GROUPS, []));
    return order.map((name, idx) => ({
      index: idx + 1, name, count: (groups[name] || []).length, active: active.has(name),
    }));
  }

  function toggleDedup() {
    const cur = !!GM_getValue(GM_KEY_DEDUP, true);
    GM_setValue(GM_KEY_DEDUP, !cur);
    alert(`分组合并去重已${!cur ? "开启" : "关闭"}`);
    registerMenu();
  }

  function aggregateSelectedUsernames({ silentIfEmpty = false } = {}) {
    const groups = getGroupsObj();
    const order = getGroupOrder();
    let selected = GM_getValue(GM_KEY_ACTIVE_GROUPS, []);
    if (!selected || selected.length === 0) {
      const all = order.flatMap((g) => groups[g] || []);
      if (all.length === 0) {
        if (silentIfEmpty) return [];
        throw new Error("尚未创建任何分组或分组为空。请先到“分组中心”新增。");
      }
      if (!silentIfEmpty && !confirm(`当前未选择分组，是否使用“全部分组”合并发送？（共 ${all.length} 人）`)) {
        throw new Error("已取消：未选择分组。");
      }
      return dedupMaybe(all);
    }
    const seq = order.filter((n) => selected.includes(n));
    const merged = [];
    for (const g of seq) merged.push(...(groups[g] || []));
    return dedupMaybe(merged);
  }

  function dedupMaybe(list) {
    if (!GM_getValue(GM_KEY_DEDUP, true)) return list.slice();
    const seen = new Set(); const out = [];
    for (const n of list) {
      const key = n.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(key);
    }
    return out;
  }

  // ========= 分组菜单实现 =========
  function renderGroupsPrompt(title, items) {
    let s = title;
    items.forEach((it) => (s += `  ${it.index}. ${it.name}（${it.count} 人）${it.active ? "  [已选]" : ""}\n`));
    return s;
  }

  function groupsManageCenter() {
    const items = listGroupsWithCounts();
    let msg = "【分组中心】\n（a）新增\n（e）编辑\n（d）删除\n（r）重命名\n（o）排序\n\n当前：\n";
    if (items.length === 0) msg += "（暂无分组）\n";
    else items.forEach((it) => (msg += `  ${it.index}. ${it.name}（${it.count} 人）${it.active ? "  [已选]" : ""}\n`));
    const choice = prompt(msg + "\n请输入指令（a/e/d/r/o），或留空取消：", "");
    if (!choice) return;
    const c = choice.trim().toLowerCase();

    if (c === "a") {
      const name = prompt("请输入分组名：", "");
      if (name === null) return;
      const listStr = prompt("粘贴该分组的 @ 名单（支持 @A@B@C 或空格/逗号分隔）：", "");
      if (listStr === null) return;
      const users = parseAtList(listStr);
      addOrUpdateGroup(name, users);
      alert(`已新增分组「${name}」：${users.length} 人`);
      registerMenu(); return;
    }

    if (["e","d","r","o"].includes(c) && items.length === 0) { alert("暂无分组可操作"); return; }

    if (c === "e") {
      const hint = renderGroupsPrompt("【编辑分组】请选择序号：\n", items);
      const idxStr = prompt(hint, ""); if (idxStr === null) return;
      const idx = Number(idxStr) - 1; const it = items[idx];
      if (!it) return alert("序号无效");
      const groups = getGroupsObj();
      const curStr = (groups[it.name] || []).map((n) => `@${n}`).join(" ");
      const listStr = prompt(`编辑分组「${it.name}」的 @ 名单：`, curStr);
      if (listStr === null) return;
      const users = parseAtList(listStr);
      addOrUpdateGroup(it.name, users);
      alert(`已更新分组「${it.name}」：${users.length} 人`);
      registerMenu(); return;
    }

    if (c === "d") {
      const hint = renderGroupsPrompt("【删除分组】请选择序号：\n", items);
      const idxStr = prompt(hint, ""); if (idxStr === null) return;
      const idx = Number(idxStr) - 1; const it = items[idx];
      if (!it) return alert("序号无效");
      if (!confirm(`确定删除分组「${it.name}」？该操作不可撤销。`)) return;
      deleteGroup(it.name); alert("已删除。"); registerMenu(); return;
    }

    if (c === "r") {
      const hint = renderGroupsPrompt("【重命名分组】请选择序号：\n", items);
      const idxStr = prompt(hint, ""); if (idxStr === null) return;
      const idx = Number(idxStr) - 1; const it = items[idx];
      if (!it) return alert("序号无效");
      const newName = prompt(`将「${it.name}」重命名为：`, it.name);
      if (newName === null) return;
      try { renameGroup(it.name, newName.trim()); alert("已重命名。"); registerMenu(); }
      catch (e) { alert(`失败：${e.message}`); }
      return;
    }

    if (c === "o") {
      let hint = "【调整分组顺序】请输入新的顺序（以逗号分隔的序号），例如：2,1,3,4\n当前：\n";
      items.forEach((it) => (hint += `  ${it.index}. ${it.name}\n`));
      const val = prompt(hint, ""); if (val === null) return;
      const arr = val.split(",").map((t) => Number(t.trim()) - 1);
      if (arr.some((x) => isNaN(x) || x < 0 || x >= items.length) || new Set(arr).size !== items.length) return alert("顺序格式无效。");
      const newOrder = arr.map((i) => items[i].name);
      setGroupOrder(newOrder); alert("已调整顺序。"); registerMenu(); return;
    }

    alert("未知指令。");
  }

  function groupsSelectActive() {
    const items = listGroupsWithCounts();
    if (items.length === 0) return alert("暂无分组，请先新增。");
    let msg = "选择要用于发送的分组（可多选）：\n";
    items.forEach((it) => (msg += `  ${it.index}. ${it.name}（${it.count} 人）${it.active ? "  [已选]" : ""}\n`));
    msg += "\n输入：\n - 多个序号用逗号（如 1,3）\n - all = 全部\n - 0 = 清空\n";
    const input = prompt(msg, ""); if (input === null) return;
    const s = input.trim().toLowerCase();
    if (s === "all") { GM_setValue(GM_KEY_ACTIVE_GROUPS, items.map((it) => it.name)); alert("已选择全部分组。"); registerMenu(); return; }
    if (s === "0" || s === "") { GM_setValue(GM_KEY_ACTIVE_GROUPS, []); alert("已清空选择。"); registerMenu(); return; }
    const idxs = s.split(",").map((t) => Number(t.trim()) - 1);
    if (idxs.some((i) => isNaN(i) || i < 0 || i >= items.length)) return alert("序号无效");
    const names = idxs.map((i) => items[i].name);
    GM_setValue(GM_KEY_ACTIVE_GROUPS, names); alert("已选择分组：" + names.join(", ")); registerMenu();
  }

  function groupsPreviewActive() {
    let users;
    try { users = aggregateSelectedUsernames({ silentIfEmpty: true }); }
    catch (e) { return alert(e.message); }
    const chunks = chunkBy(users, AT_LIMIT_PER_COMMENT);
    let msg = `当前选择共 ${users.length} 人，将分 ${chunks.length} 条发送。\n前 100 人预览：\n`;
    msg += users.slice(0, 100).map((n) => `@${n}`).join(" ");
    alert(msg);
  }

  function groupsImportExport() {
    const act = prompt("输入 e=导出 / i=导入：", "e"); if (act === null) return;
    const c = act.trim().toLowerCase();
    if (c === "e") {
      const data = { order: getGroupOrder(), groups: getGroupsObj() };
      const str = JSON.stringify(data, null, 2);
      try { GM_setClipboard(str, { type: "text", mimetype: "text/plain" }); alert("已复制到剪贴板。"); }
      catch (_) { prompt("复制以下 JSON：", str); }
    } else if (c === "i") {
      const json = prompt("粘贴导入的 JSON：", ""); if (json === null) return;
      try {
        const data = JSON.parse(json);
        if (!data || !data.groups || !data.order) throw new Error("结构无效");
        setGroupsObj(data.groups); setGroupOrder(data.order);
        alert("导入成功。"); registerMenu();
      } catch (e) { alert("导入失败：" + e.message); }
    } else { alert("无效指令。"); }
  }

  function toggleAutoMode() {
    const next = !GM_getValue(GM_KEY_AUTO_MODE, true);
    GM_setValue(GM_KEY_AUTO_MODE, next);
    alert("自动选择模式已" + (next ? "开启" : "关闭"));
    registerMenu();
  }

  // ========= 手动模式配置 =========
  function switchManualMode() {
    const cur = GM_getValue(GM_KEY_MODE, ReplyMode.THREAD_SELF);
    const hint = `当前手动模式：${
      cur === ReplyMode.TOP ? "【顶层直发】" : cur === ReplyMode.THREAD_SELF ? "【楼中楼-中奖楼】" : "【绑定楼】"
    }\n\n输入数字切换（仅在关闭“自动选择模式”时生效）：\n  1 = 顶层直发\n  2 = 楼中楼（中奖楼）\n  3 = 绑定楼\n`;
    const choice = prompt(hint, ""); if (choice === null) return;
    let next = cur;
    if (choice.trim() === "1") next = ReplyMode.TOP;
    else if (choice.trim() === "2") next = ReplyMode.THREAD_SELF;
    else if (choice.trim() === "3") next = ReplyMode.THREAD_BIND;
    else return alert("无效输入");
    GM_setValue(GM_KEY_MODE, next); alert("已切换手动模式。"); registerMenu();
  }

  function setupThreadConfig() {
    const curPrefix = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
    const curDelay = Number(GM_getValue(GM_KEY_THREAD_DELAY_MS, 2500));
    const curRetry = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const curBase  = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));

    const prefix = prompt("占楼文案（不能是单个标点）：", curPrefix); if (prefix === null) return;
    const t = prefix.trim(); if (!isNonPunctuation(t)) return alert("占楼文案不能是空或单个标点。");
    GM_setValue(GM_KEY_THREAD_PREFIX, t);

    const d = prompt("首条楼中楼发送前延迟（毫秒）", String(curDelay)); if (d === null) return;
    const r = prompt("单条失败重试次数（建议3）", String(curRetry)); if (r === null) return;
    const b = prompt("重试基准延迟（毫秒，建议1200）", String(curBase)); if (b === null) return;
    GM_setValue(GM_KEY_THREAD_DELAY_MS, Math.max(0, Number(d)||0));
    GM_setValue(GM_KEY_RETRY_TIMES, Math.max(0, Number(r)||0));
    GM_setValue(GM_KEY_RETRY_BASE_MS, Math.max(100, Number(b)||1200));
    alert("已保存。");
  }

  function togglePageHook() {
    const next = !GM_getValue(GM_KEY_HOOK_ENABLED, true);
    GM_setValue(GM_KEY_HOOK_ENABLED, next);
    if (next) { injectPageHook(); alert("已启用页面钩子；在目标楼回一条任意内容即可自动记忆。"); }
    else alert("已关闭页面钩子。");
    registerMenu();
  }

  // ========= BV/AV 转换 & rpid 解析 =========
  const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
  const base = globalThis.BigInt(58);
  const xor_val = globalThis.BigInt("23442827791579");
  const mask = globalThis.BigInt("2251799813685247");
  const tr = new Map(Array.from(table).map((c, i) => [c, globalThis.BigInt(i)]));

  function dec(bvid) {
    let r = Array.from(bvid);
    [r[3], r[9]] = [r[9], r[3]];
    [r[4], r[7]] = [r[7], r[4]];
    let tmp = globalThis.BigInt(0);
    for (let char of r.slice(3)) tmp = tmp * base + tr.get(char);
    return (tmp & mask) ^ xor_val;
  }

  function getOidFromUrl() {
    const path = location.pathname;
    const av = path.match(/\/video\/av(\d+)/i);
    const bv = path.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
    if (av && av[1]) return av[1];
    if (bv && bv[1]) return dec(bv[1]).toString();
    throw new Error("未在 URL 中找到 av/BV 号。");
  }

  function parseRpidFromText(s) {
    if (!s) return null;
    const text = String(s);
    const regs = [
      /#reply(\d{5,})/i,                           // 优先解析 #reply123...
      /[#?&](?:reply|rpid|root|parent)=?(\d{5,})/i // 其次解析 query 形式
    ];
    for (const re of regs) {
      const m = text.match(re);
      if (m && m[1]) return Number(m[1]);
    }
    return null;
  }

  // 初次进入/锚点变化：仅根据 URL 记一次；无锚则清空
  function syncSessionBindFromUrl() {
    const r = parseRpidFromText(location.href);
    if (r) setSessionBind(r, "url"); else clearSessionBind();
  }
  window.addEventListener("hashchange", syncSessionBindFromUrl);
  syncSessionBindFromUrl();

  // ========= 鉴权 & API =========
  function getAuthTokens() {
    return new Promise((resolve, reject) => {
      const sessdata = GM_getValue(GM_KEY_SESSDATA, null);
      if (!sessdata) return reject("未配置 SESSDATA！请通过菜单设置。");
      GM_cookie.list({ domain: ".bilibili.com" }, (cookies, err) => {
        if (err) return reject(`获取 bili_jct 失败: ${err}`);
        const csrf = cookies.find((c) => c.name === "bili_jct")?.value;
        if (!csrf) return reject("Cookie 中未找到 bili_jct。");
        resolve({ sessdata, csrf });
      });
    });
  }

  function postAddReply({ sessdata, csrf, oid, message, root = 0, parent = 0 }) {
    const params = new URLSearchParams();
    params.append("type", "1");
    params.append("oid", oid);
    params.append("message", message);
    params.append("plat", "1");
    params.append("csrf", csrf);
    params.append("root", String(root));
    params.append("parent", String(parent));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://api.bilibili.com/x/v2/reply/add",
        data: params.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Cookie: `SESSDATA=${sessdata}`,
        },
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data.code === 0) resolve(data);
            else reject(new Error(data.message || `API code=${data.code}`));
          } catch (_) { reject(new Error("解析响应失败")); }
        },
        onerror: (e) => reject(new Error(e?.statusText || "网络请求失败")),
      });
    });
  }

  // ========= 发送逻辑 =========
  async function sendTopLevelGroupComment() {
    const users = aggregateSelectedUsernames();
    if (users.length === 0) throw new Error("所选分组为空。");
    const chunks = chunkBy(users, AT_LIMIT_PER_COMMENT);
    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    if (!confirm(`主楼将发送 ${users.length} 人，共 ${chunks.length} 条。是否继续？`)) return;

    GM_notification({ title: "B站一键@", text: `开始发送，共 ${chunks.length} 条。`, timeout: 3000 });

    let ok = 0, fail = 0;
    const retries = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const baseDelay = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));

    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(() => postAddReply({ sessdata, csrf, oid, message: msg, root: 0, parent: 0 }), { retries, baseDelay });
        ok++;
      } catch (e) {
        console.error(`第 ${i + 1} 条失败：`, e);
        fail++; GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条失败：${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }
    GM_notification({ title: "B站一键@", text: `完成：成功 ${ok} / 失败 ${fail}`, timeout: 5000 });
  }

  async function sendThreadSelfGroupComment() {
    const users = aggregateSelectedUsernames();
    if (users.length === 0) throw new Error("所选分组为空。");
    const chunks = chunkBy(users, AT_LIMIT_PER_COMMENT);
    const prefix = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：").trim();
    if (!isNonPunctuation(prefix)) throw new Error("占楼文案不能是空或单个标点。");

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    if (!confirm(`先占楼：“${prefix}”\n再在楼中楼分 ${chunks.length} 条发送 @。是否继续？`)) return;

    GM_notification({ title: "B站一键@", text: "正在占楼...", timeout: 3000 });
    const occupyRes = await postAddReply({ sessdata, csrf, oid, message: prefix, root: 0, parent: 0 });
    const rootRpid = occupyRes?.data?.rpid || occupyRes?.data?.reply?.rpid;
    if (!rootRpid) throw new Error("占楼成功但未拿到 rpid。");

    const delayMs = Number(GM_getValue(GM_KEY_THREAD_DELAY_MS, 2500));
    if (delayMs > 0) await sleep(delayMs);

    let ok = 0, fail = 0;
    const retries = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const baseDelay = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));
    GM_notification({ title: "B站一键@", text: `开始在楼中楼发送（rpid=${rootRpid}）`, timeout: 3000 });

    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(() => postAddReply({ sessdata, csrf, oid, message: msg, root: rootRpid, parent: rootRpid }), { retries, baseDelay });
        ok++;
      } catch (e) {
        console.error(`第 ${i + 1} 条楼中楼失败：`, e);
        fail++; GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条失败：${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }
    GM_notification({ title: "B站一键@", text: `完成：成功 ${ok} / 失败 ${fail}`, timeout: 5000 });
  }

  async function sendThreadBindUsing(rpid) {
    const users = aggregateSelectedUsernames();
    if (users.length === 0) throw new Error("所选分组为空。");
    const chunks = chunkBy(users, AT_LIMIT_PER_COMMENT);
    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    if (!confirm(`将在 rpid=${rpid} 的楼中楼分 ${chunks.length} 条发送 @。是否继续？`)) return;

    let ok = 0, fail = 0;
    const retries = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const baseDelay = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));
    GM_notification({ title: "B站一键@", text: `开始在 rpid=${rpid} 的楼中楼发送`, timeout: 3000 });

    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(() => postAddReply({ sessdata, csrf, oid, message: msg, root: rpid, parent: rpid }), { retries, baseDelay });
        ok++;
      } catch (e) {
        console.error(`第 ${i + 1} 条失败：`, e);
        fail++; GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条失败：${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }

    // —— 用完即丢：清空 session & 移除 #reply 避免误连发
    const hashRpid = parseRpidFromText(location.href);
    if (hashRpid === Number(rpid)) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
    }
    clearSessionBind();

    GM_notification({ title: "B站一键@", text: `完成：成功 ${ok} / 失败 ${fail}`, timeout: 5000 });
  }

  // ========= 路由（自动 / 手动）=========
  async function routeSend({ sourceEl, source = "avatar" }) {
    try {
      const auto = !!GM_getValue(GM_KEY_AUTO_MODE, true);
      if (auto) await routeAutoSend();
      else await routeManualSend();
    } catch (err) {
      console.error("发送出错：", err);
      GM_notification({ title: "B站一键@", text: `发送失败：${err.message}`, timeout: 5000 });
    }
  }

  async function routeManualSend() {
    const mode = GM_getValue(GM_KEY_MODE, ReplyMode.THREAD_SELF);
    if (mode === ReplyMode.TOP) return sendTopLevelGroupComment();
    if (mode === ReplyMode.THREAD_SELF) return sendThreadSelfGroupComment();
    if (mode === ReplyMode.THREAD_BIND) {
      if (sessionBind.rpid) return sendThreadBindUsing(sessionBind.rpid);
      const ok = confirm("当前无绑定楼（未检测到 #reply，且未捕捉到你在某楼的最近回复）。\n将回退为“中奖楼模式”。是否继续？\n提示：若需绑定某楼，请先在该楼随便发一条内容，或从带 #reply 的链接进入。");
      if (!ok) return;
      return sendThreadSelfGroupComment();
    }
  }

  async function routeAutoSend() {
    // 优先：#reply（URL）或最近一次“测试回复”（页面钩子）
    // - 若 URL 含 #reply：直接提示“将绑定楼发送”
    // - 若无 #reply 但钩子捕捉到 root：提示“检测到你刚回复过的楼，将绑定楼发送”；否则回退中奖楼并提示可先发一条获取绑定
    const rpidFromUrl = parseRpidFromText(location.href);
    if (rpidFromUrl) {
      const ok = confirm(`检测到 URL 含 #reply（rpid=${rpidFromUrl}）。\n将绑定该楼的楼中楼发送 @，是否继续？`);
      if (!ok) return;
      return sendThreadBindUsing(rpidFromUrl);
    }

    if (sessionBind.rpid && sessionBind.source === "hook") {
      const ok2 = confirm(`检测到你刚在某楼回复（rpid=${sessionBind.rpid}）。\n将绑定该楼的楼中楼发送 @，是否继续？`);
      if (!ok2) return;
      return sendThreadBindUsing(sessionBind.rpid);
    }

    const ok3 = confirm("未检测到 #reply，且未捕捉到你在某楼的最近回复。\n将改用“中奖楼模式”（占楼→楼中楼@）。是否继续？\n提示：若需绑定某楼，请先在该楼随便发一条内容，或从带 #reply 的链接进入。");
    if (!ok3) return;
    return sendThreadSelfGroupComment();
  }

  // ========= 劫持评论框头像（主楼 & 楼中楼） =========
  function hookAllCommentBoxAvatars() {
    const host = document.querySelector("bili-comments");
    if (!host) return;
    function dfs(root) {
      if (!root) return;
      const boxes = root.querySelectorAll?.("bili-comment-box");
      boxes?.forEach((box) => {
        const sr = box.shadowRoot;
        const avatar = sr?.querySelector("#user-avatar");
        if (avatar && !avatar.dataset.biliAtV42) {
          avatar.dataset.biliAtV42 = "1";
          avatar.style.cursor = "pointer";
          avatar.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            routeSend({ sourceEl: avatar, source: "avatar" });
          });
        }
      });
      const all = root.querySelectorAll?.("*");
      all?.forEach((el) => el.shadowRoot && dfs(el.shadowRoot));
    }
    dfs(host.shadowRoot);
  }

  GM_addStyle(`#user-avatar{cursor:pointer!important;transform:scale(1.1);transition:transform .2s;}#user-avatar:hover{opacity:.8;}`);
  const mo = new MutationObserver(() => { try { hookAllCommentBoxAvatars(); } catch (e) {} });
  mo.observe(document.body, { childList: true, subtree: true });
  hookAllCommentBoxAvatars();

  // ========= 页面钩子（默认开启；仅关注 /x/v2/reply/add）=========
  if (GM_getValue(GM_KEY_HOOK_ENABLED, true)) injectPageHook();
  function injectPageHook() {
    if (window.__BILI_AT_HOOK_INSTALLED__) return;
    window.__BILI_AT_HOOK_INSTALLED__ = true;
    const s = document.createElement("script");
    s.textContent = `
      (function(){
        if (window.__BILI_AT_HOOK_INSTALLED__) return;
        window.__BILI_AT_HOOK_INSTALLED__ = true;
        function emit(detail){ try{ window.dispatchEvent(new CustomEvent('__BILI_REPLY_ADD__',{detail})); }catch(_){} }
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m,u){ this.__b_u=u; return origOpen.apply(this, arguments); };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(b){
          try{
            const u=String(this.__b_u||'');
            if(u.includes('/x/v2/reply/add')){
              let t=''; if(typeof b==='string') t=b;
              else if(b instanceof FormData){ const p=new URLSearchParams(); b.forEach((v,k)=>p.append(k,v)); t=p.toString(); }
              const p=new URLSearchParams(String(t));
              const root = p.get('root'); const parent = p.get('parent');
              if (root && parent && root === parent && /^\\d+$/.test(root)) {
                emit({root: root, from: 'hook'});
              }
              this.addEventListener('readystatechange',function(){
                if(this.readyState===4&&this.status===200){
                  try{const r=JSON.parse(this.responseText); if(r?.data?.rpid) emit({rpid:String(r.data.rpid),ok:true});}catch(_){}
                }
              });
            }
          }catch(_){}
          return origSend.apply(this, arguments);
        };
        const origFetch = window.fetch;
        window.fetch = function(i,init){
          try{
            const u=typeof i==='string'?i:(i&&i.url)||'';
            if(String(u).includes('/x/v2/reply/add')){
              let b=init&&init.body; let t='';
              if(typeof b==='string') t=b;
              else if(b instanceof FormData){ const p=new URLSearchParams(); b.forEach((v,k)=>p.append(k,v)); t=p.toString(); }
              const p=new URLSearchParams(String(t));
              const root = p.get('root'); const parent = p.get('parent');
              if (root && parent && root === parent && /^\\d+$/.test(root)) {
                emit({root: root, from: 'hook'});
              }
            }
          }catch(_){}
          return origFetch.apply(this, arguments);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(s);
    s.remove();

    // 脚本侧接收：记住最近一次“用户主动回楼”的 root
    window.addEventListener("__BILI_REPLY_ADD__", (e) => {
      try {
        const d = e.detail || {};
        const r = d.root && /^\d+$/.test(String(d.root)) ? Number(d.root) : null;
        if (r) setSessionBind(r, "hook");
      } catch (_) {}
    }, false);
  }

  // 离开/刷新自然清空（session内变量）；这里不持久化 rpid
})();
