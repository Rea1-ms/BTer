// ==UserScript==
// @name         B站评论一键@（含中奖楼）
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  「v3.5」一键@：支持顶层直发；新增“中奖楼”模式（先发占楼再在楼中楼@）；实验支持“绑定当前楼”。自动按10人/条分片。点击任何评论输入框旁的头像即可执行。
// @author       Gemini & User
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

  // --- 1. 常量 & 存储键 ---
  const GM_KEY_SESSDATA = "BILI_SESSDATA";
  const GM_KEY_GROUP = "BILI_AT_GROUP_USERNAMES";
  const GM_KEY_MODE = "BILI_AT_REPLY_MODE"; // 'top' | 'threadSelf' | 'threadBind'
  const GM_KEY_THREAD_PREFIX = "BILI_AT_THREAD_PREFIX";
  const AT_LIMIT_PER_COMMENT = 10; // B站API限制

  const ReplyMode = {
    TOP: "top",             // 顶层直发
    THREAD_SELF: "threadSelf", // 中奖楼：自建楼后在楼中楼发
    THREAD_BIND: "threadBind"  // 绑定当前楼（实验）
  };

  // 缺省：保持和原版一致（默认顶层直发）
  if (!GM_getValue(GM_KEY_MODE)) {
    GM_setValue(GM_KEY_MODE, ReplyMode.TOP);
  }
  if (!GM_getValue(GM_KEY_THREAD_PREFIX)) {
    GM_setValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
  }

  // --- 2. 菜单 ---
  GM_registerMenuCommand("1. 设置SESSDATA", setupSessdata);
  GM_registerMenuCommand("2. 设置@分组 (粘贴@列表)", setupGroup);
  GM_registerMenuCommand("3. 切换一键@模式", switchMode);
  GM_registerMenuCommand("4. 设置“中奖楼”占楼文案", setupThreadPrefix);
  GM_registerMenuCommand("5. 立即执行一键@（按当前模式）", () => routeSend({ source: "menu" }));

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
    let currentGroup = GM_getValue(GM_KEY_GROUP, []); // ['A','B',...]
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
      alert(
        `分组保存成功！共 ${newGroup.length} 人。\n\n${newGroup.map((n) => `@${n}`).join(" ")}`
      );
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
          : "【绑定当前楼(实验)】"
      }\n\n` +
      "输入数字切换：\n" +
      "  1 = 顶层直发（按 10 人一条直接在主楼）\n" +
      "  2 = 楼中楼（中奖楼）：先发占楼文案，再在楼中楼分片@\n" +
      "  3 = 绑定当前楼（实验）：尝试识别你点击处所在楼，失败则自动改用 #2\n";

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
          : "绑定当前楼（实验）")
    );
  }

  function setupThreadPrefix() {
    const current = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：");
    const input = prompt(
      "请输入占楼用的文案（不能是单个标点）：",
      current
    );
    if (input === null) return;
    const trimmed = input.trim();
    if (!isNonPunctuation(trimmed)) {
      alert("占楼文案不能是空或单个标点。");
      return;
    }
    GM_setValue(GM_KEY_THREAD_PREFIX, trimmed);
    alert("已保存。");
  }

  // --- 3. BV/AV 转换 ---
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

  // --- 4. 工具函数：鉴权、sleep、拆分 ---
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

  function getOidFromUrl() {
    const path = location.pathname;
    const avMatch = path.match(/\/video\/av(\d+)/i);
    const bvMatch = path.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
    if (avMatch && avMatch[1]) return avMatch[1];
    if (bvMatch && bvMatch[1]) return dec(bvMatch[1]).toString();
    throw new Error("未能在 URL 中找到 av 号或 BV 号。");
  }

  function chunkBy(arr, size) {
    const ret = [];
    for (let i = 0; i < arr.length; i += size) ret.push(arr.slice(i, i + size));
    return ret;
  }

  function isNonPunctuation(str) {
    if (!str) return false;
    const onlyPunct = /^[\p{P}\p{S}\s]+$/u; // 标点/符号/空白
    return !onlyPunct.test(str);
  }

  // --- 5. 封装 API: /x/v2/reply/add ---
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
            if (res.code === 0) {
              resolve(res);
            } else {
              reject(new Error(res.message || `API 返回异常 code=${res.code}`));
            }
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

  // --- 6. 发送逻辑（顶层 / 中奖楼 / 绑定当前楼[实验]）---

  // 顶层直发（与你原版 sendGroupComment 基本一致，稍作封装）
  async function sendTopLevelGroupComment() {
    const group = GM_getValue(GM_KEY_GROUP, []);
    if (group.length === 0) throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    const chunks = chunkBy(group, AT_LIMIT_PER_COMMENT);
    if (
      !confirm(
        `「请确认」\n即将在主楼发送 ${group.length} 人的 @\n将自动分为 ${chunks.length} 条评论发送。\n（评论内容仅为 @ 名单）\n\n是否继续？`
      )
    ) return;

    GM_notification({ title: "B站一键@", text: `开始发送... 共 ${chunks.length} 条评论。`, timeout: 3000 });

    let success = 0, fail = 0;
    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await postAddReply({ sessdata, csrf, oid, message: msg, root: 0, parent: 0 });
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

  // 中奖楼：先发占楼 -> 拿 rpid -> 楼中楼分片@
  async function sendThreadSelfGroupComment() {
    const group = GM_getValue(GM_KEY_GROUP, []);
    if (group.length === 0) throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");

    const threadPrefix = GM_getValue(GM_KEY_THREAD_PREFIX, "中奖名单：").trim();
    if (!isNonPunctuation(threadPrefix)) throw new Error("占楼文案不能是空或单个标点。");

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    const chunks = chunkBy(group, AT_LIMIT_PER_COMMENT);
    if (
      !confirm(
        `「请确认」\n将先发送占楼评论：「${threadPrefix}」\n随后在楼中楼分 ${chunks.length} 条发送 @（每条最多 10 人）。\n\n是否继续？`
      )
    ) return;

    GM_notification({ title: "B站一键@", text: "正在占楼...", timeout: 3000 });

    // 1) 发送占楼
    const occupyRes = await postAddReply({
      sessdata, csrf, oid, message: threadPrefix, root: 0, parent: 0
    });

    // 2) 解析 rpid
    const rootRpid = occupyRes?.data?.rpid || occupyRes?.data?.reply?.rpid;
    if (!rootRpid) throw new Error("占楼成功但未拿到 rpid。");

    // 3) 楼中楼分片@
    GM_notification({ title: "B站一键@", text: `占楼成功（rpid=${rootRpid}），开始在楼中楼发送...`, timeout: 4000 });

    let success = 0, fail = 0;
    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        // 注意：回复到楼中楼通常为 root=rootRpid，parent=rootRpid
        await postAddReply({ sessdata, csrf, oid, message: msg, root: rootRpid, parent: rootRpid });
        success++;
      } catch (e) {
        console.error(`第 ${i + 1} 条楼中楼失败:`, e);
        fail++;
        GM_notification({
          title: "B站一键@",
          text: `第 ${i + 1} 条楼中楼发送失败: ${e.message}`,
          timeout: 4000
        });
      }
      if (i < chunks.length - 1) await sleep(1500);
    }

    GM_notification({
      title: "B站一键@",
      text: `中奖楼发送完成！成功 ${success} 条 / 失败 ${fail} 条`,
      timeout: 5000
    });
  }

  // 绑定当前楼（实验）：尽力从点击位置推断 rpid；失败回退到 中奖楼
  async function sendThreadBindCurrentFloorComment(contextEl) {
    const group = GM_getValue(GM_KEY_GROUP, []);
    if (group.length === 0) throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");

    const oid = getOidFromUrl();
    const { sessdata, csrf } = await getAuthTokens();

    // 实验性：尝试从包含该输入框的组件上解析 rpid/root
    let guessedRoot = tryGuessRootRpidFromAvatar(contextEl);
    if (!guessedRoot) {
      console.warn("未能识别当前楼 rpid，将回退为 中奖楼模式。");
      // 回退为 中奖楼
      return sendThreadSelfGroupComment();
    }

    const chunks = chunkBy(group, AT_LIMIT_PER_COMMENT);
    if (
      !confirm(
        `「请确认」\n将绑定当前楼（rpid=${guessedRoot}）在楼中楼分 ${chunks.length} 条发送 @（每条最多 10 人）。\n\n是否继续？`
      )
    ) return;

    GM_notification({ title: "B站一键@", text: `识别到当前楼 rpid=${guessedRoot}，开始发送...`, timeout: 3000 });

    let success = 0, fail = 0;
    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].map((n) => `@${n}`).join(" ");
      try {
        await postAddReply({ sessdata, csrf, oid, message: msg, root: guessedRoot, parent: guessedRoot });
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

  // --- 7. 路由：根据模式发送 ---
  async function routeSend({ sourceEl, source = "avatar" }) {
    try {
      const mode = GM_getValue(GM_KEY_MODE, ReplyMode.TOP);
      if (mode === ReplyMode.TOP) {
        await sendTopLevelGroupComment();
      } else if (mode === ReplyMode.THREAD_SELF) {
        await sendThreadSelfGroupComment();
      } else if (mode === ReplyMode.THREAD_BIND) {
        await sendThreadBindCurrentFloorComment(sourceEl);
      }
    } catch (err) {
      console.error("发送出错：", err);
      GM_notification({ title: "B站一键@", text: `发送失败：${err.message}`, timeout: 5000 });
    }
  }

  // --- 8. 劫持所有评论输入框头像（含主楼 & 楼中楼）---
  // 递归扫描 shadowRoot，给每个 bili-comment-box 的 #user-avatar 绑事件
  function hookAllCommentBoxAvatars() {
    const rootHost = document.querySelector("bili-comments");
    if (!rootHost) return;

    function dfsDoc(docOrShadowRoot) {
      if (!docOrShadowRoot) return;

      // 1) 本层查找 comment-box
      const boxes = docOrShadowRoot.querySelectorAll?.("bili-comment-box");
      boxes?.forEach((box) => {
        const sr = box.shadowRoot;
        const avatar = sr?.querySelector("#user-avatar");
        if (avatar && !avatar.dataset.geminiLoadedV35) {
          avatar.dataset.geminiLoadedV35 = "true";
          avatar.style.cursor = "pointer";
          avatar.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            routeSend({ sourceEl: avatar, source: "avatar" });
          });
        }
      });

      // 2) 递归所有拥有 shadowRoot 的子元素
      const all = docOrShadowRoot.querySelectorAll?.("*");
      all?.forEach((el) => {
        if (el.shadowRoot) dfsDoc(el.shadowRoot);
      });
    }

    // 先从 comments 宿主自身的 shadowRoot 开始
    dfsDoc(rootHost.shadowRoot);
  }

  // 原版对主楼头像做了样式增强，这里保留并拓展
  GM_addStyle(`
    #user-avatar { cursor: pointer !important; transform: scale(1.1); transition: transform 0.2s; }
    #user-avatar:hover { opacity: 0.8; }
  `);

  const observer = new MutationObserver(() => {
    try {
      hookAllCommentBoxAvatars();
    } catch (e) {
      console.warn("hookAllCommentBoxAvatars 过程中出错：", e);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  // 初始执行一次
  hookAllCommentBoxAvatars();

  // --- 9. 实验性：从当前楼上下文尝试推断 rpid（失败率较高，失败会回退中奖楼）---
  function tryGuessRootRpidFromAvatar(avatarEl) {
    try {
      // 思路：从头像所在的 comment-box 祖先一路向上，尝试在附近节点和其 shadowRoot 内
      // 查找可能的 rpid 标记；由于 bilibili 使用 web components，标记名经常变更，
      // 下面做“尽力而为”的多关键字探测。
      const rootChain = [];
      let node = avatarEl;
      // 穿透 shadow 边界
      for (let step = 0; step < 10 && node; step++) {
        rootChain.push(node);
        // 跳到宿主
        const rn = node.getRootNode && node.getRootNode();
        if (rn && rn.host) {
          node = rn.host;
        } else {
          node = node.parentElement;
        }
      }

      const tryAttrs = ["data-rpid", "data-root", "data-id", "data-comment-id"];
      for (const n of rootChain) {
        for (const key of tryAttrs) {
          const v = n.getAttribute?.(key);
          if (v && /^\d+$/.test(v)) {
            return Number(v);
          }
        }
        // 在其 shadowRoot 再找一遍
        if (n.shadowRoot) {
          const cand = n.shadowRoot.querySelector?.(
            "[data-rpid],[data-root],[data-id],[data-comment-id]"
          );
          const v =
            cand?.getAttribute?.("data-rpid") ||
            cand?.getAttribute?.("data-root") ||
            cand?.getAttribute?.("data-id") ||
            cand?.getAttribute?.("data-comment-id");
          if (v && /^\d+$/.test(v)) return Number(v);
        }
      }
    } catch (e) {
      console.warn("tryGuessRootRpidFromAvatar 出错：", e);
    }
    return null;
  }
})();
