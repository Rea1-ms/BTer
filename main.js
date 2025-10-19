// ==UserScript==
// @name         B站评论一键@分组 (API版)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  点击评论框头像，自动读取评论框内容，并附加@分组后通过API发送。需要手动配置SESSDATA和分组。
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

(function() {
    'use strict';

    // --- 1. 存储键名 ---
    const GM_KEY_SESSDATA = "BILI_SESSDATA";
    const GM_KEY_GROUP = "BILI_AT_GROUP";

    // --- 2. 分组与SESSDATA管理 (油猴菜单) ---

    // 注册菜单
    GM_registerMenuCommand('1. 设置SESSDATA', setupSessdata);
    GM_registerMenuCommand('2. 设置@分组 (名字:UID)', setupGroup);

    /**
     * 菜单：设置SESSDATA
     */
    function setupSessdata() {
        let currentSessdata = GM_getValue(GM_KEY_SESSDATA, "");
        let input = prompt("【重要】请输入你的SESSDATA值：\n(SESSDATA是HttpOnly Cookie，脚本无法自动获取，请手动F12在Cookie中复制)", currentSessdata);

        if (input !== null) { // 用户点击了"确定"
            const trimmedInput = input.trim();
            if (trimmedInput) {
                GM_setValue(GM_KEY_SESSDATA, trimmedInput);
                alert("SESSDATA 已保存！");
            } else {
                GM_setValue(GM_KEY_SESSDATA, "");
                alert("SESSDATA 已清空。");
            }
        }
    }

    /**
     * 菜单：设置@分组
     */
    function setupGroup() {
        // 1. 读取旧数据，并转换回字符串
        let currentGroup = GM_getValue(GM_KEY_GROUP, []); // 格式: [{name: 'A', uid: '123'}]
        let currentGroupString = currentGroup.map(user => `${user.name}:${user.uid}`).join(', ');

        // 2. 弹出输入框
        let inputString = prompt(
            "请输入@分组名单，格式如下：\n名字1:UID1, 名字2:UID2, 名字3:UID3\n\n(UID在用户B站空间URL里，如 space.bilibili.com/UID)",
            currentGroupString
        );

        if (inputString === null) return; // 用户点击了"取消"

        // 3. 解析用户输入
        try {
            const newGroup = inputString.split(',')
                .map(pairStr => pairStr.trim()) // 去除 "名字:UID" 前后的空格
                .filter(pairStr => pairStr.includes(':')) // 确保包含冒号
                .map(pairStr => {
                    let parts = pairStr.split(':');
                    let name = parts[0].trim(); // 去除名字前后的空格
                    let uid = parts[1].trim(); // 去除UID前后的空格
                    if (!name || !uid || !/^\d+$/.test(uid)) { // 简单验证UID是否为纯数字
                        throw new Error(`格式错误: "${pairStr}"`);
                    }
                    return { name: name, uid: uid };
                });

            // 4. 保存
            GM_setValue(GM_KEY_GROUP, newGroup);
            alert(`分组保存成功！共 ${newGroup.length} 人。\n\n${newGroup.map(u => u.name).join(', ')}`);

        } catch (e) {
            alert(`保存失败！${e.message}\n\n请严格遵守 “名字:UID, 名字:UID” 的格式（注意是英文逗号和冒号）。`);
        }
    }

    // --- 3. BV/AV 转换算法 (v1.4 最终版) ---
    const table = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
    const base = 58n;
    const xor_val = 23442827791579n;
    const mask = 2251799813685247n;
    const tr = new Map();
    for (let i = 0; i < table.length; i++) { tr.set(table[i], BigInt(i)); }

    function dec(bvid) {
        let r = Array.from(bvid);
        [r[3], r[9]] = [r[9], r[3]];
        [r[4], r[7]] = [r[7], r[4]];
        let tmp = 0n;
        for(let char of r.slice(3)) {
            tmp = tmp * base + tr.get(char);
        }
        return (tmp & mask) ^ xor_val;
    }

    // --- 4. 核心：API请求 ---

    /**
     * 【重大更新】获取认证信息
     * SESSDATA: 从GM_getValue (手动) 获取
     * bili_jct: 从GM_cookie (自动) 获取
     */
    function getAuthTokens() {
        return new Promise((resolve, reject) => {
            console.log('[Token Auth] 开始获取Auth Tokens (v2.0)...');

            // 1. 获取手动的 SESSDATA
            const sessdata = GM_getValue(GM_KEY_SESSDATA, null);
            if (!sessdata) {
                return reject('未配置SESSDATA！请点击油猴菜单【1. 设置SESSDATA】。');
            }
            console.log('[Token Auth] 手动SESSDATA已读取。');

            // 2. 自动获取 bili_jct
            GM_cookie.list({ domain: '.bilibili.com' }, (cookies, error) => {
                if (error) {
                    return reject(`自动获取bili_jct失败: ${error}`);
                }
                const csrf = cookies.find(c => c.name === 'bili_jct')?.value;
                if (!csrf) {
                    return reject('自动获取bili_jct失败！Cookie中未找到。');
                }
                console.log('[Token Auth] 自动bili_jct已找到。');
                resolve({ sessdata, csrf });
            });
        });
    }

    /**
     * 【重大更新】发送评论 (v2.0 最终版)
     * @param {Element} commentBoxShadowRoot - 评论框的 Shadow DOM 根
     */
    async function sendGroupComment(commentBoxShadowRoot) {
        console.log('开始发送@分组评论 (v2.0)...');
        try {
            // --- 1. 获取评论内容 ---
            // (这是对评论框选择器的*猜测*，如果失败，你需要F12在 'bili-comment-box' 的 shadow-root 中找到它)
            const editorSelector = '.editor, .rich-text-area, div[contenteditable="true"], .brt-editor';
            const editor = commentBoxShadowRoot.querySelector(editorSelector);

            if (!editor) {
                throw new Error(`未找到评论输入框！(尝试的选择器: ${editorSelector})`);
            }

            const base_message = editor.innerText.trim(); // 获取纯文本内容
            if (!base_message) {
                throw new Error('评论内容不能为空！');
            }

            // --- 2. 获取@分组 ---
            const group = GM_getValue(GM_KEY_GROUP, []);
            if (group.length === 0) {
                throw new Error('您还没有设置@分组！请点击油猴菜单【2. 设置@分组】。');
            }

            // --- 3. 获取 OID (aid) ---
            const path = location.pathname;
            const avMatch = path.match(/\/video\/av(\d+)/i);
            const bvMatch = path.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
            let oid;

            if (avMatch && avMatch[1]) {
                oid = avMatch[1];
            } else if (bvMatch && bvMatch[1]) {
                oid = dec(bvMatch[1]).toString(); // BigInt to string
            } else {
                throw new Error('未能在URL中找到av号或BV号。');
            }
            console.log(`获取到 OID(aid): ${oid}`);

            // --- 4. 获取认证信息 ---
            const { sessdata, csrf } = await getAuthTokens();
            console.log('Auth Tokens 获取成功，准备发送API请求...');

            // --- 5. 准备最终数据 ---
            const at_map = {};
            const at_names = [];
            group.forEach(user => {
                at_map[user.name] = user.uid;
                at_names.push(`@${user.name}`);
            });

            const final_message = `${base_message} ${at_names.join(' ')}`;
            const at_name_to_mid_json = JSON.stringify(at_map);

            // 弹窗确认
            if (!confirm(`即将发送评论并@ ${group.length} 人：\n\n${final_message}`)) {
                console.log('用户取消了发送。');
                return;
            }

            // --- 6. 构造表单数据 ---
            const params = new URLSearchParams();
            params.append('type', '1');
            params.append('oid', oid);
            params.append('message', final_message); // 【使用合并后的消息】
            params.append('plat', '1');
            params.append('csrf', csrf);
            params.append('root', '0');
            params.append('parent', '0');
            params.append('at_name_to_mid', at_name_to_mid_json); // 【使用@分组JSON】

            // --- 7. 发送API请求 ---
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://api.bilibili.com/x/v2/reply/add",
                data: params.toString(),
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    // 【关键】手动设置 SESSDATA
                    "Cookie": `SESSDATA=${sessdata}`
                },
                onload: function(response) {
                    const res = JSON.parse(response.responseText);
                    if (res.code === 0) {
                        console.log('评论成功！');
                        GM_notification({ title: 'B站@分组', text: '评论发送成功！', timeout: 3000 });
                        editor.innerHTML = ''; // 发送成功后清空评论框
                    } else {
                        throw new Error(`评论失败: ${res.message} (Code: ${res.code})`);
                    }
                },
                onerror: function(error) {
                    throw new Error(`GM_xmlhttpRequest 错误: ${error.statusText}`);
                }
            });

        } catch (err) {
            console.error('发送评论时出错:', err);
            GM_notification({
                title: 'B站@分组',
                text: `发送失败: ${err.message}`,
                timeout: 5000
            });
        }
    }

    // --- 5. 劫持按钮 (Shadow DOM 探测) ---
    const observer = new MutationObserver((mutations, obs) => {
        const commentsApp = document.querySelector('bili-comments');
        if (!commentsApp) return;

        const commentBox = commentsApp.shadowRoot?.querySelector('bili-comment-box');
        if (!commentBox) return;

        // 我们需要保留这个引用，以便传递给发送函数
        const commentBoxShadowRoot = commentBox.shadowRoot;
        if (!commentBoxShadowRoot) return;

        const avatar = commentBoxShadowRoot.querySelector('#user-avatar');
        if (!avatar) return;

        // 防止重复绑定
        if (avatar.dataset.geminiLoaded) {
            return;
        }
        avatar.dataset.geminiLoaded = 'true';

        console.log('成功找到目标头像元素，准备劫持...');
        // obs.disconnect(); // 保持观察，B站UI可能会重绘

        GM_addStyle('#user-avatar { cursor: pointer !important; transform: scale(1.1); transition: transform 0.2s; } #user-avatar:hover { opacity: 0.8; }');

        avatar.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // 【新】调用最终的发送函数
            sendGroupComment(commentBoxShadowRoot);
        });

        GM_notification({ title: 'B站@分组脚本', text: '“劫持”头像按钮成功！(v2.0)', timeout: 3000 });
    });

    console.log('B站@分组脚本：开始观察页面... (v2.0)');
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

})();