#!/usr/bin/env node
/*
把 heybox_sign.js / heybox_roll.js 的控制台输出汇总成 GitHub Actions 运行摘要。

背景：Actions 的运行摘要会长期留在仓库的 Actions 页面，所以这里只挑白名单字段
      （账号昵称/ID、任务状态、H 币、活动状态），绝不写入接口原始 body ——
      抽奖脚本的报错行里带 body，动辄上万字符。

用法：
  node scripts/summarize.js --sign sign.log --roll roll.log > summary.md
  node scripts/summarize.js --sign sign.log                      # 只有签到结果
  cat summary.md >> "$GITHUB_STEP_SUMMARY"
*/
const fs = require("fs");

/* ----------------------------- 参数与清洗 ----------------------------- */

function parseArgs(argv) {
  const args = { sign: "", roll: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sign") args.sign = argv[++i] || "";
    else if (argv[i] === "--roll") args.roll = argv[++i] || "";
  }
  return args;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const TS_PREFIX = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/;
// 账号行形如：账号[1][2528****]签到: 已完成 (+30H币)
const ACCOUNT_PREFIX = /^账号\[(\d+)\]\[([^\]]*)\](.*)$/;

const NOISE = [
  /^##\[/,
  /^node heybox_/,
  /^shell: /,
  /^env:$/,
  /^heybox_ck: /,
  /^-{5,}$/,
  /^读取到的脚本变量:$/,
  /^共读取到\d+个账号$/,
  /^开始运行$/,
  /^通知发送失败: /,
  /^\[小黑盒\./,
];

/** 逐行读日志，剥掉 ANSI、时间戳和「账号[n][id]」前缀。 */
function readEntries(file) {
  if (!file || !fs.existsSync(file)) return null;
  const entries = [];
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const rawLine of raw) {
    const line = rawLine.replace(ANSI, "").replace(TS_PREFIX, "").trimEnd();
    if (!line) continue;
    if (NOISE.some((rx) => rx.test(line))) continue;
    // 报错行可能带接口原始 body，只保留前缀并截断
    const text = line.length > 300 ? line.slice(0, 300) : line;
    const match = text.match(ACCOUNT_PREFIX);
    if (match) entries.push({ index: match[1], id: match[2], text: match[3].trim() });
    else entries.push({ index: "", id: "", text });
  }
  return entries;
}

const trimEnd = (text) => String(text ?? "").replace(/\s+$/, "");
const esc = (text) => String(text ?? "").replace(/\|/g, "\\|");

/* ----------------------------- 签到日志解析 ----------------------------- */

function parseSign(entries) {
  if (!entries) return null;
  const result = { accounts: [], total: "", result: "", error: "", version: "", accountsFound: false };
  const byIndex = new Map();

  const accountOf = (index, id) => {
    if (!byIndex.has(index)) {
      const account = { index, id: id || "", name: "", imei: "", coins: "", tasks: [] };
      byIndex.set(index, account);
      result.accounts.push(account);
    }
    if (id) byIndex.get(index).id = id;
    return byIndex.get(index);
  };

  for (const entry of entries) {
    const { index, id, text } = entry;

    if (/^(Error:|HTTP错误|##\[error\])/.test(text)) {
      if (!result.error) result.error = text.slice(0, 200);
      continue;
    }
    if (/^未读取到任何账号/.test(text)) {
      result.accountsFound = false;
      if (!result.error) result.error = text.slice(0, 200);
      continue;
    }
    if (index) {
      let m = text.match(/^账号=(\S+)\s+黑盒ID=(\S+)\s+IMEI=(\S+)/);
      if (m) {
        const account = accountOf(index, id);
        account.name = m[1];
        account.imei = m[3];
        continue;
      }
      m = text.match(/^当前总H币:\s*(.*)$/);
      if (m) {
        accountOf(index, id).coins = trimEnd(m[1]);
        continue;
      }
      // 任务行：签到: 已完成 (+30H币 +30经验 +1盒电)
      m = text.match(/^([^:：]{2,40})[:：]\s*(已完成|未完成|失败|已跳过|跳过|部分完成)(.*)$/);
      if (m) {
        accountOf(index, id).tasks.push({ name: m[1].trim(), status: m[2], reward: trimEnd(m[3]) });
        continue;
      }
    }

    let m = text.match(/^当前版本:\s*(.*)$/);
    if (m) {
      result.version = trimEnd(m[1]) || result.version;
      continue;
    }
    m = text.match(/^完成:\s*(\d+)\/(\d+)$/);
    if (m) {
      result.total = `${m[1]}/${m[2]}`;
      continue;
    }
    m = text.match(/^RESULT:\s*sign=(\w+)\s+tasks=(\S+)/);
    if (m) {
      result.result = `sign=${m[1]} tasks=${m[2]}`;
      continue;
    }
  }
  return result;
}

/* ----------------------------- 抽奖日志解析 ----------------------------- */

function parseRoll(entries) {
  if (!entries) return null;
  const result = { awards: [], unsupported: [], total: "", error: "" };
  let current = null;

  for (const entry of entries) {
    const { text } = entry;

    if (/^(Error:|HTTP错误|##\[error\])/.test(text)) {
      if (!result.error) result.error = text.slice(0, 200);
      continue;
    }

    let m = text.match(/^抽奖活动 award_id=(\d+)\s*(.*)$/);
    if (m) {
      current = { awardId: m[1], name: trimEnd(m[2]), tickets: "-", joined: false, skipped: false };
      result.awards.push(current);
      continue;
    }
    if (!current) continue;

    m = text.match(/^help_code=\S+\s+my_ticket=(\d+)\s+joined=(true|false)/);
    if (m) {
      current.tickets = m[1];
      current.joined = m[2] === "true";
      continue;
    }
    if (/前置参与任务未完成，跳过参与抽奖/.test(text)) {
      current.skipped = true;
      continue;
    }
    m = text.match(/^未自动处理任务:\s*(.+)$/);
    if (m) {
      for (const item of m[1].split(/[,，]\s*/).map((s) => s.trim()).filter(Boolean)) {
        if (!result.unsupported.includes(item)) result.unsupported.push(item);
      }
      continue;
    }
    m = text.match(/^抽奖活动处理完成:\s*(.*)$/);
    if (m) {
      result.total = trimEnd(m[1]);
      continue;
    }
  }
  return result;
}

/* ----------------------------- 渲染 ----------------------------- */

const STATUS_ICON = {
  已完成: "✅ 已完成",
  部分完成: "🟡 部分完成",
  未完成: "⬜ 未完成",
  已跳过: "⭕ 已跳过",
  跳过: "⭕ 已跳过",
  失败: "❌ 失败",
};

function nowInBeijing() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (UTC+8)`;
}

function render(sign, roll) {
  const out = [];
  const accounts = sign ? sign.accounts : [];
  const signError = sign ? sign.error : "";
  const rollError = roll ? roll.error : "";
  const awardCount = roll ? roll.awards.length : 0;
  const joinedCount = roll ? roll.awards.filter((a) => a.joined).length : 0;
  const skippedCount = roll ? roll.awards.filter((a) => a.skipped).length : 0;

  const allTasksDone =
    accounts.length > 0 &&
    accounts.every((a) => a.tasks.length > 0 && a.tasks.every((t) => t.status === "已完成"));
  // 脚本已经给出机器可读结论（RESULT: sign=ok|fail），优先用它定调
  const signFailed = Boolean(sign && sign.result && sign.result.includes("sign=fail"));
  const headline = signFailed
    ? "❌ 签到失败"
    : allTasksDone
      ? "✅ 签到成功"
      : accounts.length
        ? "🟡 签到完成，部分日常任务未自动化"
        : "❌ 未取到签到结果";

  out.push("## 小黑盒每日任务");
  out.push("");
  out.push(`**${headline}**`);
  out.push("");
  out.push("| 项目 | 值 |");
  out.push("| --- | --- |");
  out.push(`| 运行时间 | ${nowInBeijing()} |`);
  if (sign && sign.total) out.push(`| 日常任务完成 | ${esc(sign.total)} |`);
  if (sign && sign.result) out.push(`| 脚本结论 | \`${esc(sign.result)}\` |`);
  if (accounts.length) {
    out.push(`| 账号 | ${accounts.map((a) => `**${esc(a.name || a.id || "-")}**（${esc(a.id || "-")}）`).join("、")} |`);
  }
  const coins = accounts.map((a) => a.coins).filter(Boolean);
  if (coins.length) out.push(`| 当前 H 币 | ${esc(coins.join(" / "))} |`);
  if (sign && sign.version) out.push(`| 客户端版本 | ${esc(sign.version)} |`);
  if (awardCount) out.push(`| 抽奖活动 | 进行中 ${awardCount} 个，参与成功 ${joinedCount} 个，跳过 ${skippedCount} 个 |`);
  if (roll && roll.total) out.push(`| 抽奖处理 | ${esc(roll.total)} |`);

  if (accounts.length) {
    out.push("");
    out.push("### 每日任务");
    for (const account of accounts) {
      if (accounts.length > 1) {
        out.push("");
        out.push(`**账号${account.index} · ${esc(account.name || "-")}（${esc(account.id || "-")}）**`);
        out.push("");
      }
      out.push("| 任务 | 状态 | 奖励 |");
      out.push("| --- | --- | --- |");
      if (!account.tasks.length) {
        out.push("| （没有任务记录，通常是 cookie 失效导致接口返回 relogin） | - | - |");
      }
      for (const task of account.tasks) {
        out.push(`| ${esc(task.name)} | ${STATUS_ICON[task.status] || esc(task.status)} | ${esc(task.reward || "-")} |`);
      }
    }
  }

  if (awardCount) {
    out.push("");
    out.push("### 0 元抽奖盒券");
    out.push("");
    out.push("| 活动 ID | 活动 | 状态 | 我的盒券 |");
    out.push("| --- | --- | --- | --- |");
    for (const award of roll.awards) {
      const status = award.joined ? "✅ 已参与" : award.skipped ? "⭕ 跳过" : "⬜ 未参与";
      out.push(`| ${esc(award.awardId)} | ${esc(award.name || "-")} | ${status} | ${esc(award.tickets)} |`);
    }
    if (roll.unsupported.length) {
      out.push("");
      out.push(`> 需要手动完成的前置任务：${esc(roll.unsupported.join("、"))}（脚本无法自动完成，属正常现象）`);
    }
  }

  const notes = [];
  if (signError) notes.push(`签到脚本报错：\`${esc(signError)}\``);
  if (rollError) notes.push(`抽奖脚本报错：\`${esc(rollError)}\``);
  if (!accounts.length && !signError) {
    notes.push("未解析到签到结果，请展开步骤日志查看原因（最常见是 `heybox_ck` 过期或 secret 未配置）。");
  }
  if (notes.length) {
    out.push("");
    for (const note of notes) out.push(`> ⚠️ ${note}`);
  }

  out.push("");
  out.push("<sub>摘要只包含白名单字段（昵称 / ID / 任务状态 / H 币 / 活动状态），不写入接口原始响应。</sub>");
  return `${out.join("\n")}\n`;
}

/* ----------------------------- 入口 ----------------------------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sign = parseSign(readEntries(args.sign));
  const roll = parseRoll(readEntries(args.roll));
  process.stdout.write(render(sign, roll));
}

if (require.main === module) main();

module.exports = { parseSign, parseRoll, render, readEntries };
