// ==UserScript==
// @name         B站评论一键@（含中奖楼 / 绑定指定楼 / 可选页面钩子）
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  「v3.6」一键@：顶层直发；中奖模式；绑定指定楼（粘贴评论链接或 rpid、自动识别地址栏#reply/?reply）；可选页面钩子自动捕捉当前楼root/parent（默认关闭）。每条最多@10人。
// @author       Gemini & ChatGPT & User
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // --- 1. 存储键 & 常量 ---
  const GM_KEY_SESSDATA = "BILI_SESSDATA";
  const GM_KEY_GROUP = "BILI_AT_GROUP_USERNAMES";
  const GM_KEY_MODE = "BILI_AT_REPLY_MODE"; // 'top' | 'threadSelf' | 'threadBind'
  const GM_KEY_THREAD_PREFIX = "BILI_AT_THREAD_PREFIX";

  // 新增：中奖楼延迟 & 重试
  const GM_KEY_THREAD_DELAY_MS = "BILI_AT_THREAD_DELAY_MS"; // 首条楼中楼发送前延迟
  const GM_KEY_RETRY_TIMES = "BILI_AT_RETRY_TIMES";         // 单条发送失败重试次数
  const GM_KEY_RETRY_BASE_MS = "BILI_AT_RETRY_BASE_MS";     // 重试基准延迟

  // 新增：绑定指定楼（不猜 DOM）
  const GM_KEY_BIND_ROOT_RPID = "BILI_AT_BIND_ROOT_RPID";

  // 可选：页面钩子开关（默认 false）
  const GM_KEY_HOOK_ENABLED = "BILI_AT_ENABLE_PAGE_HOOK";

  const AT_LIMIT_PER_COMMENT = 10; // B站API限制

  const ReplyMode = {
    TOP: "top",             // 顶层直发
    THREAD_SELF: "threadSelf", // 中奖楼：自建楼后在楼中楼发
    THREAD_BIND: "threadBind"  // 绑定指定楼（由链接/rpid/地址栏/或可选钩子提供）
  };

  // 默认配置
  if (!GM_getValue(GM_KEY_MODE)) GM_setValue(GM_KEY_MODE, ReplyMode.TOP);
  if (!GM_getValue(GM_KEY_THREAD_PREFIX)) GM_setValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
  if (GM_getValue(GM_KEY_THREAD_DELAY_MS) == null) GM_setValue(GM_KEY_THREAD_DELAY_MS, 2500); // 2.5s
  if (GM_getValue(GM_KEY_RETRY_TIMES) == null) GM_setValue(GM_KEY_RETRY_TIMES, 3);
  if (GM_getValue(GM_KEY_RETRY_BASE_MS) == null) GM_setValue(GM_KEY_RETRY_BASE_MS, 1200);
  if (GM_getValue(GM_KEY_HOOK_ENABLED) == null) GM_setValue(GM_KEY_HOOK_ENABLED, false);

  // --- 2. 菜单 ---
  GM_registerMenuCommand("1. 设置SESSDATA", setupSessdata);
  GM_registerMenuCommand("2. 设置@分组 (粘贴@列表)", setupGroup);
  GM_registerMenuCommand("3. 切换一键@模式", switchMode);
  GM_registerMenuCommand("4. 设置“中奖楼”占楼文案", setupThreadPrefix);
  GM_registerMenuCommand("5. 立即执行一键@（按当前模式）", () => routeSend({ source: "menu" }));
  GM_registerMenuCommand("6. 中奖楼：设置首发延迟/重试", setupDelayRetry);
  GM_registerMenuCommand("7. 绑定指定楼：粘贴评论链接或 rpid", setupBindRootRpid);
  GM_registerMenuCommand("8.（可选）页面钩子：启/停捕捉当前楼 root/parent", togglePageHook);

  // --- 3. 菜单实现 ---
  function setupSessdata() {
    let currentSessdata = GM_getValue(GM_KEY_SESSDATA, "");
    let input = prompt(
      "「重要」请输入你的 SESSDATA 值：\n(SESSDATA 是 HttpOnly Cookie，请在浏览器开发者工具的 Cookie 面板手动复制)",
      currentSessdata
    );
    if (input !== null) {
      const trimmedInput = input.trim();
      GM_setValue(GM_KEY_SESSDATA, trimmedInput);
      alert(trimmedInput ? "SESSDATA 已保存！" : "SESSDATA 已清空。");
    }
  }

  function setupGroup() {
    let currentGroup = GM_getValue(GM_KEY_GROUP, []);
    let currentGroupString = currentGroup.map((name) => `@${name}`).join(" ");

    let inputString = prompt(
      "请粘贴要@的用户名列表，用「@」分隔：\n(例如: @A@B@C 或者 @A @B @C)",
      currentGroupString
    );
    if (inputString === null) return;

    try {
      const newGroup = Array.from(inputString.matchAll(/@([^@]+)/g), (m) => m[1].trim())
        .filter((name) => name.length > 0);
      if (newGroup.length === 0 && inputString.length > 0) {
        throw new Error("解析失败，未找到任何有效的@用户名。");
      }
      GM_setValue(GM_KEY_GROUP, newGroup);
      alert(`分组保存成功！共 ${newGroup.length} 人。\n\n${newGroup.map((n) => `@${n}`).join(" ")}`);
    } catch (e) {
      alert(`保存失败！${e.message}\n\n请严格遵守 “@名字1@名字2” 的格式。`);
    }
  }

  function switchMode() {
    const current = GM_getValue(GM_KEY_MODE, ReplyMode.TOP);
    const hint =
      `当前模式：${
        current === ReplyMode.TOP
          ? "【顶层直发】"
          : current === ReplyMode.THREAD_SELF
          ? "【楼中楼-中奖楼】"
          : "【绑定指定楼】"
      }\n\n` +
      "输入数字切换：\n" +
      "  1 = 顶层直发（每条最多@10人）\n" +
      "  2 = 楼中楼（中奖楼）：先发占楼，再在楼中楼分片@\n" +
      "  3 = 绑定指定楼：将@到你提供的rpid对应的楼层（可从链接/地址栏自动识别）\n";
    const choice = prompt(hint, "");
    if (choice === null) return;

    let next = current;
    if (choice.trim() === "1") next = ReplyMode.TOP;
    else if (choice.trim() === "2") next = ReplyMode.THREAD_SELF;
    else if (choice.trim() === "3") next = ReplyMode.THREAD_BIND;
    else {
      alert("无效输入。");
      return;
    }
    GM_setValue(GM_KEY_MODE, next);
    alert(
      "已切换模式为：" +
        (next === ReplyMode.TOP
          ? "顶层直发"
          : next === ReplyMode.THREAD_SELF
          ? "楼中楼（中奖楼）"
          : "绑定指定楼")
    );
  }

  function setupThreadPrefix() {
    const current = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
    const input = prompt("请输入占楼用的文案（不能是单个标点）：", current);
    if (input === null) return;
    const trimmed = input.trim();
    if (!isNonPunctuation(trimmed)) {
      alert("占楼文案不能是空或单个标点。");
      return;
    }
    GM_setValue(GM_KEY_THREAD_PREFIX, trimmed);
    alert("已保存。");
  }

  function setupDelayRetry() {
    const curDelay = Number(GM_getValue(GM_KEY_THREAD_DELAY_MS, 2500));
    const curRetry = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const curBase  = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));
    const delay = prompt(`中奖楼模式：首条楼中楼发送前延迟（毫秒）`, String(curDelay));
    if (delay === null) return;
    const retry = prompt(`单条发送失败重试次数（建议 3）`, String(curRetry));
    if (retry === null) return;
    const base = prompt(`重试基准延迟ms（指数退避基数，建议 1200）`, String(curBase));
    if (base === null) return;
    GM_setValue(GM_KEY_THREAD_DELAY_MS, Math.max(0, Number(delay) || 0));
    GM_setValue(GM_KEY_RETRY_TIMES, Math.max(0, Number(retry) || 0));
    GM_setValue(GM_KEY_RETRY_BASE_MS, Math.max(100, Number(base) || 1200));
    alert("已保存。");
  }

  function setupBindRootRpid() {
    const cur = GM_getValue(GM_KEY_BIND_ROOT_RPID, "");
    const tip = "请粘贴“评论链接”或直接输入 rpid（纯数字）。\n我会自动解析 #reply123456789 / ?reply=123456789 / rpid=123456789 等格式。";
    const input = prompt(tip, String(cur || ""));
    if (input === null) return;
    const parsed = parseRpidFromText(input);
    if (!parsed) {
      alert("未能解析出 rpid，请检查输入。");
      return;
    }
    GM_setValue(GM_KEY_BIND_ROOT_RPID, parsed);
    alert(`已绑定楼层 rpid = ${parsed}`);
  }

  function togglePageHook() {
    const enabled = !!GM_getValue(GM_KEY_HOOK_ENABLED, false);
    const next = !enabled;
    GM_setValue(GM_KEY_HOOK_ENABLED, next);
    if (next) {
      injectPageHook();
      alert("已启用页面钩子。你在任意楼发一条测试内容后，我会自动记住该楼的 root/parent。");
    } else {
      alert("已关闭页面钩子。");
    }
  }

  // --- 4. BV/AV 转换 ---
  const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
  const base = 58n;
  const xor_val = 23442827791579n;
  const mask = 2251799813685247n;
  const tr = new Map();
  for (let i = 0; i < table.length; i++) tr.set(table[i], BigInt(i));
  function dec(bvid) {
    let r = Array.from(bvid);
    [r[3], r[9]] = [r[9], r[3]];
    [r[4], r[7]] = [r[7], r[4]];
    let tmp = 0n;
    for (let char of r.slice(3)) tmp = tmp * base + tr.get(char);
    return (tmp & mask) ^ xor_val;
  }

  // --- 5. 工具函数 ---
  function getAuthTokens() {
    return new Promise((resolve, reject) => {
      const sessdata = GM_getValue(GM_KEY_SESSDATA, null);
      if (!sessdata) return reject("未配置 SESSDATA！请点击油猴菜单「1. 设置SESSDATA」。");
      GM_cookie.list({ domain: ".bilibili.com" }, (cookies, error) => {
        if (error) return reject(`自动获取 bili_jct 失败: ${error}`);
        const csrf = cookies.find((c) => c.name === "bili_jct")?.value;
        if (!csrf) return reject("自动获取 bili_jct 失败！Cookie 中未找到。");
        resolve({ sessdata, csrf });
      });
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function chunkBy(arr, size) {
    const ret = [];
    for (let i = 0; i < arr.length; i += size) ret.push(arr.slice(i, i + size));
    return ret;
  }

  function isNonPunctuation(str) {
    if (!str) return false;
    const onlyPunct = /^[\p{P}\p{S}\s]+$/u;
    return !onlyPunct.test(str);
  }

  function getOidFromUrl() {
    const path = location.pathname;
    const avMatch = path.match(/\/video\/av(\d+)/i);
    const bvMatch = path.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
    if (avMatch && avMatch[1]) return avMatch[1];
    if (bvMatch && bvMatch[1]) return dec(bvMatch[1]).toString();
    throw new Error("未能在 URL 中找到 av 号或 BV 号。");
  }

  // 重试：指数退避
  async function withRetry(taskFn, { retries = 3, baseDelay = 1200, factor = 1.8 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await taskFn(i);
      } catch (e) {
        lastErr = e;
        if (i === retries) break;
        await sleep(Math.round(baseDelay * Math.pow(factor, i)));
      }
    }
    throw lastErr;
  }

  // 解析 rpid：支持 #reply123 / ?reply=123 / rpid=123 / parent=123 等
  function parseRpidFromText(s) {
    if (!s) return null;
    const str = String(s);
    const regs = [
      /[#?&](?:reply|rpid|root|parent)=?(\d{5,})/i,
      /#reply(\d{5,})/i,
      /\brpid\s*[:：=]\s*(\d{5,})/i,
      /\broot\s*[:：=]\s*(\d{5,})/i,
      /\bparent\s*[:：=]\s*(\d{5,})/i,
      /(\d{9,})/ // 兜底：长数字
    ];
    for (const re of regs) {
      const m = str.match(re);
      if (m && m[1]) return Number(m[1]);
    }
    return null;
  }

  function getBoundRootRpid() {
    // 1) 优先：手动绑定的 rpid
    const saved = GM_getValue(GM_KEY_BIND_ROOT_RPID, null);
    if (saved && /^\d+$/.test(String(saved))) return Number(saved);

    // 2) 其次：地址栏自动识别
    const fromUrl = parseRpidFromText(location.href);
    if (fromUrl) {
      GM_setValue(GM_KEY_BIND_ROOT_RPID, fromUrl);
      return fromUrl;
    }
    return null;
  }

  // --- 6. 封装 API: /x/v2/reply/add ---
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
        onload: function (response) {
          try {
            const res = JSON.parse(response.responseText);
            if (res.code === 0) resolve(res);
            else reject(new Error(res.message || `API code=${res.code}`));
          } catch (e) {
            reject(new Error("解析响应失败"));
          }
        },
        onerror: function (error) {
          reject(new Error(error?.statusText || "网络请求失败"));
        },
      });
    });
  }

  // --- 7. 发送逻辑（顶层 / 中奖楼 / 绑定指定楼）---

  async function sendTopLevelGroupComment() {
    const group = GM_getValue(GM_KEY_GROUP, []);
    if (group.length === 0) throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();
    const chunks = chunkBy(group, AT_LIMIT_PER_COMMENT);

    if (!confirm(`「请确认」\n主楼将发送 ${group.length} 人的 @，共 ${chunks.length} 条。\n是否继续？`)) return;

    GM_notification({ title: "B站一键@", text: `开始发送... 共 ${chunks.length} 条评论。`, timeout: 3000 });

    let success = 0, fail = 0;
    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(
          () => postAddReply({ sessdata, csrf, oid, message: msg, root: 0, parent: 0 }),
          { retries: Number(GM_getValue(GM_KEY_RETRY_TIMES, 3)), baseDelay: Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200)) }
        );
        success++;
      } catch (e) {
        console.error(`第 ${i + 1} 条失败:`, e);
        fail++;
        GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条发送失败: ${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }

    GM_notification({ title: "B站一键@", text: `完成！成功 ${success} 条 / 失败 ${fail} 条`, timeout: 5000 });
  }

  // 中奖楼：占楼 -> 延迟 -> 楼中楼分片@（含重试）
  async function sendThreadSelfGroupComment() {
    const group = GM_getValue(GM_KEY_GROUP, []);
    if (group.length === 0) throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");

    const threadPrefix = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：").trim();
    if (!isNonPunctuation(threadPrefix)) throw new Error("占楼文案不能是空或单个标点。");

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    const chunks = chunkBy(group, AT_LIMIT_PER_COMMENT);
    if (!confirm(`「请确认」\n先占楼：「${threadPrefix}」\n再在楼中楼分 ${chunks.length} 条发送 @。\n是否继续？`)) return;

    GM_notification({ title: "B站一键@", text: "正在占楼...", timeout: 3000 });

    const occupyRes = await postAddReply({ sessdata, csrf, oid, message: threadPrefix, root: 0, parent: 0 });
    const rootRpid = occupyRes?.data?.rpid || occupyRes?.data?.reply?.rpid;
    if (!rootRpid) throw new Error("占楼成功但未拿到 rpid。");

    // 关键：首发延迟，等母评论“落地”
    const delayMs = Number(GM_getValue(GM_KEY_THREAD_DELAY_MS, 2500));
    if (delayMs > 0) await sleep(delayMs);

    GM_notification({ title: "B站一键@", text: `占楼成功（rpid=${rootRpid}），开始在楼中楼发送...`, timeout: 4000 });

    let success = 0, fail = 0;
    const retries = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const baseDelay = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));

    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(
          () => postAddReply({ sessdata, csrf, oid, message: msg, root: rootRpid, parent: rootRpid }),
          { retries, baseDelay }
        );
        success++;
      } catch (e) {
        console.error(`第 ${i + 1} 条楼中楼失败:`, e);
        fail++;
        GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条楼中楼失败: ${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }

    GM_notification({ title: "B站一键@", text: `中奖楼发送完成！成功 ${success} 条 / 失败 ${fail} 条`, timeout: 5000 });
  }

  // 绑定指定楼：从绑定/地址栏获取 rpid，不猜 DOM，不遍历评论
  async function sendThreadBindComment() {
    const group = GM_getValue(GM_KEY_GROUP, []);
    if (group.length === 0) throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");

    const rootRpid = getBoundRootRpid();
    if (!rootRpid) {
      // 无 rpid：回退到中奖楼
      alert("未绑定目标楼 rpid（可粘贴评论链接或 rpid 绑定）。将回退为“中奖楼”模式。");
      return sendThreadSelfGroupComment();
    }

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();
    const chunks = chunkBy(group, AT_LIMIT_PER_COMMENT);

    if (!confirm(`「请确认」\n将在 rpid=${rootRpid} 的楼中楼分 ${chunks.length} 条发送 @。\n是否继续？`)) return;

    GM_notification({ title: "B站一键@", text: `开始在 rpid=${rootRpid} 的楼中楼发送...`, timeout: 3000 });

    let success = 0, fail = 0;
    const retries = Number(GM_getValue(GM_KEY_RETRY_TIMES, 3));
    const baseDelay = Number(GM_getValue(GM_KEY_RETRY_BASE_MS, 1200));

    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await withRetry(
          () => postAddReply({ sessdata, csrf, oid, message: msg, root: rootRpid, parent: rootRpid }),
          { retries, baseDelay }
        );
        success++;
      } catch (e) {
        console.error(`第 ${i + 1} 条失败:`, e);
        fail++;
        GM_notification({ title: "B站一键@", text: `第 ${i + 1} 条发送失败: ${e.message}`, timeout: 4000 });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }

    GM_notification({ title: "B站一键@", text: `完成！成功 ${success} 条 / 失败 ${fail} 条`, timeout: 5000 });
  }

  // --- 8. 路由 ---
  async function routeSend({ sourceEl, source = "avatar" }) {
    try {
      const mode = GM_getValue(GM_KEY_MODE, ReplyMode.TOP);
      if (mode === ReplyMode.TOP) {
        await sendTopLevelGroupComment();
      } else if (mode === ReplyMode.THREAD_SELF) {
        await sendThreadSelfGroupComment();
      } else if (mode === ReplyMode.THREAD_BIND) {
        await sendThreadBindComment();
      }
    } catch (err) {
      console.error("发送出错：", err);
      GM_notification({ title: "B站一键@", text: `发送失败：${err.message}`, timeout: 5000 });
    }
  }

  // --- 9. 劫持所有评论输入框头像（主楼 & 楼中楼）---
  function hookAllCommentBoxAvatars() {
    const rootHost = document.querySelector("bili-comments");
    if (!rootHost) return;

    function dfsDoc(docOrShadowRoot) {
      if (!docOrShadowRoot) return;
      const boxes = docOrShadowRoot.querySelectorAll?.("bili-comment-box");
      boxes?.forEach((box) => {
        const sr = box.shadowRoot;
        const avatar = sr?.querySelector("#user-avatar");
        if (avatar && !avatar.dataset.geminiLoadedV36) {
          avatar.dataset.geminiLoadedV36 = "true";
          avatar.style.cursor = "pointer";
          avatar.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            routeSend({ sourceEl: avatar, source: "avatar" });
          });
        }
      });
      const all = docOrShadowRoot.querySelectorAll?.("*");
      all?.forEach((el) => el.shadowRoot && dfsDoc(el.shadowRoot));
    }
    dfsDoc(rootHost.shadowRoot);
  }

  GM_addStyle(`
    #user-avatar { cursor: pointer !important; transform: scale(1.1); transition: transform 0.2s; }
    #user-avatar:hover { opacity: 0.8; }
  `);

  const observer = new MutationObserver(() => {
    try { hookAllCommentBoxAvatars(); } catch (e) { console.warn("hookAllCommentBoxAvatars 出错：", e); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  hookAllCommentBoxAvatars();

  // --- 10. 地址栏 #reply/?reply 自动捕捉 rpid ---
  function tryCaptureRpidFromUrl() {
    const r = parseRpidFromText(location.href);
    if (r) GM_setValue(GM_KEY_BIND_ROOT_RPID, r);
  }
  window.addEventListener("hashchange", tryCaptureRpidFromUrl);
  tryCaptureRpidFromUrl();

  // --- 11. 可选进阶：页面上下文钩子（默认关闭）---
  // 说明：这不是“抓包工具”，只是覆写 page scope 的 fetch/XHR，拦截向 /x/v2/reply/add 提交的 body，
  // 把 root/parent/oid 信息通过 CustomEvent 回传给脚本，用于“绑定当前楼”。需要你先手动发一条测试回复。
  function injectPageHook() {
    if (window.__BILI_AT_HOOK_INSTALLED__) return;
    window.__BILI_AT_HOOK_INSTALLED__ = true;

    const s = document.createElement("script");
    s.textContent = `
      (function(){
        if (window.__BILI_AT_HOOK_INSTALLED__) return;
        window.__BILI_AT_HOOK_INSTALLED__ = true;

        function emit(detail){
          try {
            window.dispatchEvent(new CustomEvent('__BILI_REPLY_ADD__', { detail }));
          } catch(_) {}
        }

        // XHR hook
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url){
          this.__bili_url = url;
          return origOpen.apply(this, arguments);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body){
          try {
            const url = String(this.__bili_url || '');
            if (url.includes('/x/v2/reply/add')) {
              let text = '';
              if (typeof body === 'string') text = body;
              else if (body instanceof FormData) {
                const usp = new URLSearchParams();
                body.forEach((v,k)=>usp.append(k, v));
                text = usp.toString();
              } else if (body) {
                try { text = new TextDecoder().decode(body); } catch (_) {}
              }
              const p = new URLSearchParams(String(text));
              const detail = {
                root: p.get('root'),
                parent: p.get('parent'),
                oid: p.get('oid'),
                message: p.get('message')
              };
              emit(detail);

              this.addEventListener('readystatechange', function(){
                if (this.readyState === 4 && this.status === 200) {
                  try {
                    const res = JSON.parse(this.responseText);
                    if (res?.data?.rpid) emit({rpid: String(res.data.rpid), ok: true});
                  } catch(_){}
                }
              });
            }
          } catch(_) {}
          return origSend.apply(this, arguments);
        };

        // fetch hook
        const origFetch = window.fetch;
        window.fetch = function(input, init){
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (String(url).includes('/x/v2/reply/add')) {
              let body = init && init.body;
              let text = '';
              if (typeof body === 'string') text = body;
              else if (body instanceof FormData) {
                const usp = new URLSearchParams();
                body.forEach((v,k)=>usp.append(k, v));
                text = usp.toString();
              }
              const p = new URLSearchParams(String(text));
              emit({ root: p.get('root'), parent: p.get('parent'), oid: p.get('oid'), message: p.get('message') });
            }
          } catch(_) {}
          return origFetch.apply(this, arguments);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(s);
    s.remove();

    // 脚本侧接收并存储 rpid/root/parent
    window.addEventListener("__BILI_REPLY_ADD__", (e) => {
      try {
        const d = e.detail || {};
        const root = d.root && /^\d+$/.test(String(d.root)) ? Number(d.root) : null;
        if (root) GM_setValue(GM_KEY_BIND_ROOT_RPID, root);
      } catch (_) {}
    }, false);
  }

  if (GM_getValue(GM_KEY_HOOK_ENABLED, false)) {
    injectPageHook();
  }
})();
