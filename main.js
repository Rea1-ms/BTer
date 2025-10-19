// ==UserScript==
// @name         B站评论一键@（多分组 / 中奖楼 / 绑定指定楼 / 可选钩子）
// @namespace    http://tampermonkey.net/
// @version      3.8
// @description  一键@：支持“多分组”管理与多选合并（可去重、可预览）；模式含 顶层直发 / 中奖楼（占楼→延迟→楼中楼分片@，含重试） / 绑定指定楼（链接或rpid），并可选页面钩子自动捕捉root/parent。每条最多@10人，自动分片。
// @author       Gemini & User
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

(function () {
  "use strict";

  // ========= 1) 键名 & 常量 =========
  const AT_LIMIT_PER_COMMENT = 10;

  // 鉴权 / 旧版本兼容
  const GM_KEY_SESSDATA = "BILI_SESSDATA";
  const GM_KEY_LEGACY_GROUP = "BILI_AT_GROUP_USERNAMES"; // v3.6单名单
  const GM_KEY_MODE = "BILI_AT_REPLY_MODE"; // 'top'|'threadSelf'|'threadBind'
  const GM_KEY_THREAD_PREFIX = "BILI_AT_THREAD_PREFIX";
  const GM_KEY_THREAD_DELAY_MS = "BILI_AT_THREAD_DELAY_MS";
  const GM_KEY_RETRY_TIMES = "BILI_AT_RETRY_TIMES";
  const GM_KEY_RETRY_BASE_MS = "BILI_AT_RETRY_BASE_MS";
  const GM_KEY_BIND_ROOT_RPID = "BILI_AT_BIND_ROOT_RPID";
  const GM_KEY_HOOK_ENABLED = "BILI_AT_ENABLE_PAGE_HOOK";

  // 分组系统（v3.8+）
  const GM_KEY_GROUPS = "BILI_AT_GROUPS";              // { [groupName]: string[] }
  const GM_KEY_GROUP_ORDER = "BILI_AT_GROUP_ORDER";    // string[]
  const GM_KEY_ACTIVE_GROUPS = "BILI_AT_ACTIVE_GROUPS";// string[]
  const GM_KEY_DEDUP = "BILI_AT_DEDUP";                // boolean

  const ReplyMode = { TOP: "top", THREAD_SELF: "threadSelf", THREAD_BIND: "threadBind" };

  // ========= 2) 初始化 & 兼容迁移 =========
  initDefaults();
  migrateFromLegacyIfNeeded();

  function initDefaults() {
    if (!GM_getValue(GM_KEY_MODE)) GM_setValue(GM_KEY_MODE, ReplyMode.TOP);
    if (!GM_getValue(GM_KEY_THREAD_PREFIX)) GM_setValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
    if (GM_getValue(GM_KEY_THREAD_DELAY_MS) == null) GM_setValue(GM_KEY_THREAD_DELAY_MS, 2500);
    if (GM_getValue(GM_KEY_RETRY_TIMES) == null) GM_setValue(GM_KEY_RETRY_TIMES, 3);
    if (GM_getValue(GM_KEY_RETRY_BASE_MS) == null) GM_setValue(GM_KEY_RETRY_BASE_MS, 1200);
    if (GM_getValue(GM_KEY_HOOK_ENABLED) == null) GM_setValue(GM_KEY_HOOK_ENABLED, false);
    if (!GM_getValue(GM_KEY_GROUPS)) GM_setValue(GM_KEY_GROUPS, {});
    if (!GM_getValue(GM_KEY_GROUP_ORDER)) GM_setValue(GM_KEY_GROUP_ORDER, []);
    if (GM_getValue(GM_KEY_DEDUP) == null) GM_setValue(GM_KEY_DEDUP, true);
  }

  function migrateFromLegacyIfNeeded() {
    const groups = GM_getValue(GM_KEY_GROUPS, {});
    const order = GM_getValue(GM_KEY_GROUP_ORDER, []);
    const legacy = GM_getValue(GM_KEY_LEGACY_GROUP, []);
    if (Array.isArray(legacy) && legacy.length > 0 && Object.keys(groups).length === 0) {
      groups["default"] = legacy.slice();
      order.push("default");
      GM_setValue(GM_KEY_GROUPS, groups);
      GM_setValue(GM_KEY_GROUP_ORDER, order);
      GM_setValue(GM_KEY_ACTIVE_GROUPS, ["default"]);
      GM_notification({ title: "B站一键@ 分组迁移", text: "已将旧名单迁移为分组：default", timeout: 5000 });
    }
  }

  // ========= 3) 菜单 =========
  GM_registerMenuCommand("1. 设置SESSDATA", setupSessdata);
  GM_registerMenuCommand("2. 分组：新增/编辑/删除/重命名", groupsManageCenter);
  GM_registerMenuCommand("3. 分组：选择当前使用分组（可多选）", groupsSelectActive);
  GM_registerMenuCommand("4. 分组：预览当前选择名单", groupsPreviewActive);
  GM_registerMenuCommand("5. 分组：导入/导出（JSON）", groupsImportExport);
  GM_registerMenuCommand("6. 分组：去重开关（当前：" + (GM_getValue(GM_KEY_DEDUP, true) ? "开" : "关") + "）", toggleDedup);
  GM_registerMenuCommand("7. 模式：切换 顶层/中奖楼/绑定指定楼", switchMode);
  GM_registerMenuCommand("8. 设置“中奖楼”占楼文案", setupThreadPrefix);
  GM_registerMenuCommand("9. 中奖楼：设置首发延迟/重试", setupDelayRetry);
  GM_registerMenuCommand("10. 绑定指定楼：粘贴评论链接或 rpid", setupBindRootRpid);
  GM_registerMenuCommand("11. （可选）页面钩子：启/停捕捉当前楼 root/parent", togglePageHook);
  GM_registerMenuCommand("12. 快速创建示例分组（杂/ba/all）", quickCreateSampleGroups);
  GM_registerMenuCommand("13. 立即执行一键@（按当前模式+分组）", () => routeSend({ source: "menu" }));

  // ========= 4) 通用工具 =========
  function setupSessdata() {
    const cur = GM_getValue(GM_KEY_SESSDATA, "");
    const val = prompt("请输入 SESSDATA（从浏览器开发者工具Cookie面板复制）", cur);
    if (val !== null) {
      GM_setValue(GM_KEY_SESSDATA, val.trim());
      alert("SESSDATA 已" + (val.trim() ? "保存" : "清空"));
    }
  }

  function parseAtList(str) {
    if (!str) return [];
    const s = String(str).trim();
    // 1) 优先解析 @Name 形式
    let list = Array.from(s.matchAll(/@([^@\s]+(?:\s*[^@\s]+)*)/g), (m) => m[1].trim()).filter(Boolean);
    // 2) 兜底：若没找到@，按逗号/空格/换行/分号分割
    if (list.length === 0) {
      list = s.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    }
    // 去除首尾标点/多余空格
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
      catch (e) {
        lastErr = e;
        if (i === retries) break;
        await sleep(Math.round(baseDelay * Math.pow(factor, i)));
      }
    }
    throw lastErr;
  }

  function isNonPunctuation(str) {
    if (!str) return false;
    const onlyPunct = /^[\p{P}\p{S}\s]+$/u;
    return !onlyPunct.test(str);
  }

  // ========= 5) 分组：数据层 =========
  function getGroupsObj() { return GM_getValue(GM_KEY_GROUPS, {}); }
  function getGroupOrder() { return GM_getValue(GM_KEY_GROUP_ORDER, []); }
  function setGroupsObj(obj) { GM_setValue(GM_KEY_GROUPS, obj); }
  function setGroupOrder(order) { GM_setValue(GM_KEY_GROUP_ORDER, order); }
  function ensureGroup(name) {
    const groups = getGroupsObj(); const order = getGroupOrder();
    if (!groups[name]) { groups[name] = []; order.push(name); setGroupsObj(groups); setGroupOrder(order); }
  }
  function addOrUpdateGroup(name, usernames) {
    name = String(name).trim();
    if (!name) throw new Error("分组名不能为空");
    const groups = getGroupsObj(); const order = getGroupOrder();
    groups[name] = Array.from(usernames || []);
    if (!order.includes(name)) order.push(name);
    setGroupsObj(groups); setGroupOrder(order);
  }
  function deleteGroup(name) {
    const groups = getGroupsObj(); const order = getGroupOrder();
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
    const groups = getGroupsObj(); const order = getGroupOrder();
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
    const groups = getGroupsObj(); const order = getGroupOrder();
    return order.map((name) => ({ name, count: (groups[name] || []).length }));
  }

  function toggleDedup() {
    const cur = !!GM_getValue(GM_KEY_DEDUP, true);
    GM_setValue(GM_KEY_DEDUP, !cur);
    alert(`分组合并去重已${!cur ? "开启" : "关闭"}`);
  }

  function aggregateSelectedUsernames() {
    const groups = getGroupsObj(); const order = getGroupOrder();
    let selected = GM_getValue(GM_KEY_ACTIVE_GROUPS, []);
    if (!selected || selected.length === 0) {
      const all = order.flatMap((g) => groups[g] || []);
      if (all.length === 0) throw new Error("尚未创建任何分组或分组为空。请先到“分组中心”新增。");
      if (!confirm(`当前未选择分组，是否使用“全部分组”合并发送？（共 ${all.length} 人）`)) {
        throw new Error("已取消：未选择分组。");
      }
      return dedupMaybe(all);
    }
    // 保持全局顺序：仅保留选中的顺序子序列
    const seq = order.filter((n) => selected.includes(n));
    const merged = [];
    for (const g of seq) {
      merged.push(...(groups[g] || []));
    }
    return dedupMaybe(merged);
  }

  function dedupMaybe(list) {
    if (!GM_getValue(GM_KEY_DEDUP, true)) return list.slice();
    const seen = new Set(); const out = [];
    for (const n of list) {
      const key = n.trim(); // 精确去重（保留大小写与空格差异已修剪）
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key); out.push(key);
    }
    return out;
  }

  // ========= 6) 分组：菜单实现 =========
  function groupsManageCenter() {
    const items = listGroupsWithCounts();
    let msg = "【分组中心】\n";
    msg += "（a）新增分组\n（e）编辑分组\n（d）删除分组\n（r）重命名分组\n（o）调整分组顺序\n\n当前分组：\n";
    if (items.length === 0) msg += "（暂无分组）\n";
    else items.forEach((it, idx) => (msg += `  ${idx + 1}. ${it.name}（${it.count} 人）\n`));
    const choice = prompt(msg + "\n请输入操作指令（a/e/d/r/o），或留空取消：", "");
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
    } else if (c === "e") {
      if (items.length === 0) return alert("暂无分组可编辑");
      const idx = prompt("请输入要编辑的分组序号：", "");
      if (idx === null) return;
      const i = Number(idx) - 1;
      if (isNaN(i) || i < 0 || i >= items.length) return alert("序号无效");
      const name = items[i].name;
      const groups = getGroupsObj();
      const curStr = (groups[name] || []).map((n) => `@${n}`).join(" ");
      const listStr = prompt(`编辑分组「${name}」的 @ 名单：`, curStr);
      if (listStr === null) return;
      const users = parseAtList(listStr);
      addOrUpdateGroup(name, users);
      alert(`已更新分组「${name}」：${users.length} 人`);
    } else if (c === "d") {
      if (items.length === 0) return alert("暂无分组可删除");
      const idx = prompt("请输入要删除的分组序号：", "");
      if (idx === null) return;
      const i = Number(idx) - 1;
      if (isNaN(i) || i < 0 || i >= items.length) return alert("序号无效");
      const name = items[i].name;
      if (!confirm(`确定删除分组「${name}」？该操作不可撤销。`)) return;
      deleteGroup(name);
      alert("已删除。");
    } else if (c === "r") {
      if (items.length === 0) return alert("暂无分组可重命名");
      const idx = prompt("请输入要重命名的分组序号：", "");
      if (idx === null) return;
      const i = Number(idx) - 1;
      if (isNaN(i) || i < 0 || i >= items.length) return alert("序号无效");
      const oldName = items[i].name;
      const newName = prompt(`将「${oldName}」重命名为：`, oldName);
      if (newName === null) return;
      try { renameGroup(oldName, newName.trim()); alert("已重命名。"); }
      catch (e) { alert(`失败：${e.message}`); }
    } else if (c === "o") {
      if (items.length < 2) return alert("分组数不足以排序");
      let hint = "请输入新的顺序（以逗号分隔的序号），例如：2,1,3,4\n当前：\n";
      items.forEach((it, idx) => (hint += `  ${idx + 1}. ${it.name}\n`));
      const val = prompt(hint, "");
      if (val === null) return;
      const arr = val.split(",").map((t) => Number(t.trim()) - 1);
      if (arr.some((x) => isNaN(x) || x < 0 || x >= items.length) || new Set(arr).size !== items.length) {
        return alert("顺序格式无效。");
      }
      const newOrder = arr.map((i) => items[i].name);
      setGroupOrder(newOrder);
      alert("已调整顺序。");
    } else {
      alert("未知指令。");
    }
  }

  function groupsSelectActive() {
    const items = listGroupsWithCounts();
    if (items.length === 0) return alert("暂无分组，请先新增。");
    let msg = "选择要用于发送的分组（可多选）：\n";
    items.forEach((it, idx) => (msg += `  ${idx + 1}. ${it.name}（${it.count} 人）\n`));
    msg += "\n输入：\n - 多个序号用逗号分隔（如 1,3）\n - all = 全部分组\n - 0 = 清空选择\n";
    const input = prompt(msg, "");
    if (input === null) return;
    const s = input.trim().toLowerCase();
    if (s === "all") {
      GM_setValue(GM_KEY_ACTIVE_GROUPS, items.map((it) => it.name));
      return alert("已选择全部分组。");
    }
    if (s === "0" || s === "") {
      GM_setValue(GM_KEY_ACTIVE_GROUPS, []);
      return alert("已清空选择。");
    }
    const idxs = s.split(",").map((t) => Number(t.trim()) - 1);
    if (idxs.some((i) => isNaN(i) || i < 0 || i >= items.length)) return alert("序号无效");
    const names = idxs.map((i) => items[i].name);
    GM_setValue(GM_KEY_ACTIVE_GROUPS, names);
    alert("已选择分组：" + names.join(", "));
  }

  function groupsPreviewActive() {
    let users;
    try { users = aggregateSelectedUsernames(); }
    catch (e) { return alert(e.message); }
    const chunks = chunkBy(users, AT_LIMIT_PER_COMMENT);
    let msg = `当前选择共 ${users.length} 人，将分 ${chunks.length} 条发送。\n前 100 人预览：\n`;
    msg += users.slice(0, 100).map((n) => `@${n}`).join(" ");
    alert(msg);
  }

  function groupsImportExport() {
    const act = prompt("输入 i=导入 / e=导出：", "e");
    if (act === null) return;
    const c = act.trim().toLowerCase();
    if (c === "e") {
      const data = { order: getGroupOrder(), groups: getGroupsObj() };
      const str = JSON.stringify(data, null, 2);
      try { GM_setClipboard(str, { type: "text", mimetype: "text/plain" }); alert("已复制到剪贴板。"); }
      catch (_) { prompt("复制以下 JSON：", str); }
    } else if (c === "i") {
      const json = prompt("粘贴导入的 JSON：", "");
      if (json === null) return;
      try {
        const data = JSON.parse(json);
        if (!data || !data.groups || !data.order) throw new Error("结构无效");
        setGroupsObj(data.groups); setGroupOrder(data.order);
        alert("导入成功。");
      } catch (e) {
        alert("导入失败：" + e.message);
      }
    } else {
      alert("无效指令。");
    }
  }

  function quickCreateSampleGroups() {
    const sample = {
      "杂": parseAtList("@Sinlahaley"),
      "ba": parseAtList("@一团玄兽"),
      "all": parseAtList("@新世纪水煮鱼@华为很卡@Bydos@Ender2021@okok-nop@yi5456@一团玄兽@我有点小方啊@IE罗罗包@孤独小偷哐哐喵@Uwjdiw"),
    };
    const groups = getGroupsObj(); const order = getGroupOrder();
    for (const [k, v] of Object.entries(sample)) {
      groups[k] = v;
      if (!order.includes(k)) order.push(k);
    }
    setGroupsObj(groups); setGroupOrder(order);
    GM_setValue(GM_KEY_ACTIVE_GROUPS, ["all"]);
    alert("已创建示例分组（杂/ba/all），并将当前使用分组设为：all");
  }

  // ========= 7) 模式 & 中奖楼配置 =========
  function switchMode() {
    const cur = GM_getValue(GM_KEY_MODE, ReplyMode.TOP);
    const hint = `当前模式：${
      cur === ReplyMode.TOP ? "【顶层直发】" : cur === ReplyMode.THREAD_SELF ? "【楼中楼-中奖楼】" : "【绑定指定楼】"
    }\n\n输入数字切换：\n  1 = 顶层直发\n  2 = 楼中楼（中奖楼）\n  3 = 绑定指定楼\n`;
    const choice = prompt(hint, "");
    if (choice === null) return;
    let next = cur;
    if (choice.trim() === "1") next = ReplyMode.TOP;
    else if (choice.trim() === "2") next = ReplyMode.THREAD_SELF;
    else if (choice.trim() === "3") next = ReplyMode.THREAD_BIND;
    else return alert("无效输入");
    GM_setValue(GM_KEY_MODE, next);
    alert("已切换模式。");
  }

  function setupThreadPrefix() {
    const cur = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
    const val = prompt("请输入占楼文案（不能是单个标点）：", cur);
    if (val === null) return;
    const t = val.trim();
    if (!isNonPunctuation(t)) return alert("占楼文案不能是空或单个标点。");
    GM_setValue(GM_KEY_THREAD_PREFIX, t);
    alert("已保存。");
  }

  function setupDelayRetry() {
    const curDelay = Number(GM_getValue(GM_KEY_THREAD_DELAY_MS, 2500));
    const curRetry = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const curBase  = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));
    const d = prompt("中奖楼：首条楼中楼发送前延迟（毫秒）", String(curDelay)); if (d === null) return;
    const r = prompt("单条失败重试次数（建议3）", String(curRetry)); if (r === null) return;
    const b = prompt("重试基准延迟（毫秒，建议1200）", String(curBase)); if (b === null) return;
    GM_setValue(GM_KEY_THREAD_DELAY_MS, Math.max(0, Number(d)||0));
    GM_setValue(GM_KEY_RETRY_TIMES, Math.max(0, Number(r)||0));
    GM_setValue(GM_KEY_RETRY_BASE_MS, Math.max(100, Number(b)||1200));
    alert("已保存。");
  }

  function setupBindRootRpid() {
    const cur = GM_getValue(GM_KEY_BIND_ROOT_RPID, "");
    const tip = "粘贴评论链接或 rpid（支持 #reply123 / ?reply=123 / rpid=123）";
    const val = prompt(tip, String(cur||""));
    if (val === null) return;
    const parsed = parseRpidFromText(val);
    if (!parsed) return alert("未解析到 rpid");
    GM_setValue(GM_KEY_BIND_ROOT_RPID, parsed);
    alert(`已绑定 rpid=${parsed}`);
  }

  function togglePageHook() {
    const next = !GM_getValue(GM_KEY_HOOK_ENABLED, false);
    GM_setValue(GM_KEY_HOOK_ENABLED, next);
    if (next) { injectPageHook(); alert("已启用页面钩子；在目标楼回一条任意内容即可自动记忆。"); }
    else alert("已关闭页面钩子。");
  }

  // ========= 8) BV/AV 转换 & URL 解析 =========
  const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
  const base = 58n, xor_val = 23442827791579n, mask = 2251799813685247n;
  const tr = new Map(Array.from(table).map((c,i)=>[c, BigInt(i)]));
  function dec(bvid) {
    let r = Array.from(bvid);
    [r[3], r[9]] = [r[9], r[3]];
    [r[4], r[7]] = [r[7], r[4]];
    let tmp = 0n;
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
      /[#?&](?:reply|rpid|root|parent)=?(\d{5,})/i,
      /#reply(\d{5,})/i,
      /\brpid\s*[:：=]\s*(\d{5,})/i,
      /\broot\s*[:：=]\s*(\d{5,})/i,
      /\bparent\s*[:：=]\s*(\d{5,})/i,
      /(\d{9,})/
    ];
    for (const re of regs) {
      const m = text.match(re);
      if (m && m[1]) return Number(m[1]);
    }
    return null;
  }
  function tryCaptureRpidFromUrl() {
    const r = parseRpidFromText(location.href);
    if (r) GM_setValue(GM_KEY_BIND_ROOT_RPID, r);
  }
  window.addEventListener("hashchange", tryCaptureRpidFromUrl);
  tryCaptureRpidFromUrl();

  // ========= 9) 鉴权 & API 封装 =========
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

  // ========= 10) 发送（三模式；名单来自“分组聚合”） =========
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

  async function sendThreadBindComment() {
    const users = aggregateSelectedUsernames();
    if (users.length === 0) throw new Error("所选分组为空。");
    const chunks = chunkBy(users, AT_LIMIT_PER_COMMENT);

    const rootRpid = GM_getValue(GM_KEY_BIND_ROOT_RPID, null) || parseRpidFromText(location.href);
    if (!rootRpid) {
      alert("未绑定 rpid，将回退为“中奖楼”模式。");
      return sendThreadSelfGroupComment();
    }

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    if (!confirm(`将在 rpid=${rootRpid} 的楼中楼分 ${chunks.length} 条发送 @。是否继续？`)) return;

    let ok = 0, fail = 0;
    const retries = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const baseDelay = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));
    GM_notification({ title: "B站一键@", text: `开始在 rpid=${rootRpid} 的楼中楼发送`, timeout: 3000 });

    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(() => postAddReply({ sessdata, csrf, oid, message: msg, root: rootRpid, parent: rootRpid }), { retries, baseDelay });
        ok++;
      } catch (e) {
        console.error(`第 ${i + 1} 条失败：`, e);
        fail++; GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条失败：${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }
    GM_notification({ title: "B站一键@", text: `完成：成功 ${ok} / 失败 ${fail}`, timeout: 5000 });
  }

  async function routeSend({ sourceEl, source = "avatar" }) {
    try {
      const mode = GM_getValue(GM_KEY_MODE, ReplyMode.TOP);
      if (mode === ReplyMode.TOP) await sendTopLevelGroupComment();
      else if (mode === ReplyMode.THREAD_SELF) await sendThreadSelfGroupComment();
      else if (mode === ReplyMode.THREAD_BIND) await sendThreadBindComment();
    } catch (err) {
      console.error("发送出错：", err);
      GM_notification({ title: "B站一键@", text: `发送失败：${err.message}`, timeout: 5000 });
    }
  }

  // ========= 11) 劫持头像（主楼 & 楼中楼）=========
  function hookAllCommentBoxAvatars() {
    const host = document.querySelector("bili-comments");
    if (!host) return;
    function dfs(root) {
      if (!root) return;
      const boxes = root.querySelectorAll?.("bili-comment-box");
      boxes?.forEach((box) => {
        const sr = box.shadowRoot;
        const avatar = sr?.querySelector("#user-avatar");
        if (avatar && !avatar.dataset.groupV38) {
          avatar.dataset.groupV38 = "1";
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

  // ========= 12) 可选：页面钩子（自动记住 root/parent）=========
  if (GM_getValue(GM_KEY_HOOK_ENABLED, false)) injectPageHook();
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
              emit({root:p.get('root'),parent:p.get('parent'),oid:p.get('oid'),message:p.get('message')});
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
              emit({root:p.get('root'),parent:p.get('parent'),oid:p.get('oid'),message:p.get('message')});
            }
          }catch(_){}
          return origFetch.apply(this, arguments);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    window.addEventListener("__BILI_REPLY_ADD__", (e) => {
      try {
        const d = e.detail || {};
        const root = d.root && /^\\d+$/.test(String(d.root)) ? Number(d.root) : null;
        if (root) GM_setValue(GM_KEY_BIND_ROOT_RPID, root);
      } catch (_) {}
    }, false);
  }
})();
