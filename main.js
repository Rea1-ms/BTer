// ==UserScript==
// @name         B站评论一键@
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  「v3.2」劫持L1主头像，点击即发送@，自动按10人/条分片。设置时可直接粘贴@列表。
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
// ==/UserScript==

(function () {
  "use strict";

  // --- 1. 存储键名 ---
  const GM_KEY_SESSDATA = "BILI_SESSDATA";
  const GM_KEY_GROUP = "BILI_AT_GROUP_USERNAMES";
  const AT_LIMIT_PER_COMMENT = 10; // B站API限制

  // --- 2. 分组与SESSDATA管理 (油猴菜单) ---

  GM_registerMenuCommand("1. 设置SESSDATA", setupSessdata);
  GM_registerMenuCommand("2. 设置@分组 (粘贴@列表)", setupGroup);

  function setupSessdata() {
    let currentSessdata = GM_getValue(GM_KEY_SESSDATA, "");
    let input = prompt(
      "「重要」请输入你的SESSDATA值：\n(SESSDATA是HttpOnly Cookie，请手动F12在Cookie中复制)",
      currentSessdata,
    );
    if (input !== null) {
      const trimmedInput = input.trim();
      GM_setValue(GM_KEY_SESSDATA, trimmedInput);
      alert(trimmedInput ? "SESSDATA 已保存！" : "SESSDATA 已清空。");
    }
  }

  /**
   * 菜单：设置@分组，使用@分割
   */
  function setupGroup() {
    let currentGroup = GM_getValue(GM_KEY_GROUP, []); // 格式: ['A', 'B', 'C']
    let currentGroupString = currentGroup.map((name) => `@${name}`).join(" "); // "@A @B @C"

    let inputString = prompt(
      "请粘贴要@的用户名列表，用「@」分隔：\n(例如: @A@B@C 或者 @A @B @C)",
      currentGroupString,
    );

    if (inputString === null) return; // 用户点击了"取消"

    try {
      const newGroup = Array.from(inputString.matchAll(/@([^@]+)/g), (match) =>
        match[1].trim(),
      ).filter((name) => name.length > 0);

      if (newGroup.length === 0 && inputString.length > 0) {
        throw new Error("解析失败，未找到任何有效的@用户名。");
      }

      GM_setValue(GM_KEY_GROUP, newGroup);
      alert(
        `分组保存成功！共 ${newGroup.length} 人。\n\n${newGroup.map((name) => `@${name}`).join(" ")}`,
      );
    } catch (e) {
      alert(`保存失败！${e.message}\n\n请严格遵守 “@名字1@名字2” 的格式。`);
    }
  }

  // --- 3. BV/AV 转换算法 ---
  const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
  const base = 58n;
  const xor_val = 23442827791579n;
  const mask = 2251799813685247n;
  const tr = new Map();
  for (let i = 0; i < table.length; i++) {
    tr.set(table[i], BigInt(i));
  }

  function dec(bvid) {
    let r = Array.from(bvid);
    [r[3], r[9]] = [r[9], r[3]];
    [r[4], r[7]] = [r[7], r[4]];
    let tmp = 0n;
    for (let char of r.slice(3)) {
      tmp = tmp * base + tr.get(char);
    }
    return (tmp & mask) ^ xor_val;
  }

  // --- 4. 核心：API请求 ---

  function getAuthTokens() {
    return new Promise((resolve, reject) => {
      const sessdata = GM_getValue(GM_KEY_SESSDATA, null);
      if (!sessdata) {
        return reject("未配置SESSDATA！请点击油猴菜单「1. 设置SESSDATA」。");
      }
      GM_cookie.list({ domain: ".bilibili.com" }, (cookies, error) => {
        if (error) {
          return reject(`自动获取bili_jct失败: ${error}`);
        }
        const csrf = cookies.find((c) => c.name === "bili_jct")?.value;
        if (!csrf) {
          return reject("自动获取bili_jct失败！Cookie中未找到。");
        }
        resolve({ sessdata, csrf });
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 发送评论
  async function sendGroupComment() {
    try {
      const group = GM_getValue(GM_KEY_GROUP, []);
      if (group.length === 0) {
        throw new Error("您还没有设置@分组！请点击油猴菜单「2. 设置@分组」。");
      }

      const path = location.pathname;
      const avMatch = path.match(/\/video\/av(\d+)/i);
      const bvMatch = path.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
      let oid;
      if (avMatch && avMatch[1]) {
        oid = avMatch[1];
      } else if (bvMatch && bvMatch[1]) {
        oid = dec(bvMatch[1]).toString();
      } else {
        throw new Error("未能在URL中找到av号或BV号。");
      }

      const { sessdata, csrf } = await getAuthTokens();

      const chunks = [];
      for (let i = 0; i < group.length; i += AT_LIMIT_PER_COMMENT) {
        chunks.push(group.slice(i, i + AT_LIMIT_PER_COMMENT));
      }

      if (
        !confirm(
          `「请确认」\n\n即将发送 ${group.length} 人的@\n将自动分为 ${chunks.length} 条评论发送。\n(评论内容将「只有」@名单)\n\n是否继续？`,
        )
      ) {
        console.log("用户取消了发送。");
        return;
      }

      GM_notification({
        title: "B站一键@",
        text: `开始发送... 共 ${chunks.length} 条评论。`,
        timeout: 3000,
      });
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const at_names_text = chunk.map((name) => `@${name}`).join(" ");
        const final_message = at_names_text;

        const params = new URLSearchParams();
        params.append("type", "1");
        params.append("oid", oid);
        params.append("message", final_message);
        params.append("plat", "1");
        params.append("csrf", csrf);
        params.append("root", "0");
        params.append("parent", "0");

        try {
          await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: "POST",
              url: "https://api.bilibili.com/x/v2/reply/add",
              data: params.toString(),
              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded;charset=UTF-8",
                Cookie: `SESSDATA=${sessdata}`,
              },
              onload: function (response) {
                const res = JSON.parse(response.responseText);
                if (res.code === 0) {
                  successCount++;
                  resolve(res);
                } else {
                  console.error(`第 ${i + 1} 条评论发送失败:`, res.message);
                  reject(new Error(res.message));
                }
              },
              onerror: function (error) {
                console.error(`第 ${i + 1} 条 GM_xmlhttpRequest 错误:`, error);
                reject(new Error(error.statusText || "网络请求失败"));
              },
            });
          });
        } catch (e) {
          failCount++;
          GM_notification({
            title: "B站一键@",
            text: `第 ${i + 1} 条发送失败: ${e.message}`,
            timeout: 4000,
          });
        }

        if (i < chunks.length - 1) {
          await sleep(1500); // 休眠1.5秒, 防止风控
        }
      }

      // --- 8. 最终总结 ---
      GM_notification({
        title: "B站一键@",
        text: `全部发送完毕！\n成功: ${successCount} 条\n失败: ${failCount} 条`,
        timeout: 5000,
      });
    } catch (err) {
      console.error("发送评论时出错:", err);
      GM_notification({
        title: "B站一键@",
        text: `发送失败: ${err.message}`,
        timeout: 5000,
      });
    }
  }

  // --- 5. 劫持 L1 主楼按钮 ---
  const observer = new MutationObserver((mutations, obs) => {
    try {
      const commentsApp = document.querySelector("bili-comments");
      if (!commentsApp) return;
      const header = commentsApp.shadowRoot?.querySelector(
        "bili-comments-header-renderer",
      );
      if (!header) return;
      const commentBox = header.shadowRoot?.querySelector("bili-comment-box");
      if (!commentBox) return;
      const commentBoxShadowRoot = commentBox.shadowRoot;
      if (!commentBoxShadowRoot) return;
      const avatar = commentBoxShadowRoot.querySelector("#user-avatar");
      if (!avatar) return;

      if (avatar.dataset.geminiLoadedV32) {
        // 更新版本锁
        return;
      }
      avatar.dataset.geminiLoadedV32 = "true";

      GM_addStyle(
        "#user-avatar { cursor: pointer !important; transform: scale(1.1); transition: transform 0.2s; } #user-avatar:hover { opacity: 0.8; }",
      );

      avatar.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendGroupComment();
      });

      obs.disconnect(); // 成功劫持后停止观察
    } catch (e) {
      console.warn("在搜寻L1头像时出错: ", e);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
