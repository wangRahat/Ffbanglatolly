const { exec } = require("child_process");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const COOKIES_PATH = "/tmp/yt_cookies.txt";

function ensureCookies() {
  const cookies = `# Netscape HTTP Cookie File
.youtube.com\tTRUE\t/\tTRUE\t2147483647\tCONSENT\tYES+BD.en+20240101-00-0
.youtube.com\tTRUE\t/\tTRUE\t2147483647\tPREF\tf4=4000000&hl=en&gl=BD
.youtube.com\tTRUE\t/\tTRUE\t2147483647\tGPS\t1
.google.com\tTRUE\t/\tTRUE\t2147483647\tCONSENT\tYES+BD.en+20240101-00-0
`;
  if (!fs.existsSync(COOKIES_PATH)) fs.writeFileSync(COOKIES_PATH, cookies);
}

// ─── FORMAT FLAGS ─────────────────────────────────────────────────────────────
const FORMAT_FLAGS = `-f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]" --merge-output-format mp4 --max-filesize 200M`;

// ─── BD PROXY FETCH ───────────────────────────────────────────────────────────
async function getFreshBDProxy() {
  try {
    const res = await axios.get(
      "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&country=bd&protocol=socks5&timeout=5000",
      { timeout: 8000 }
    );
    const lines = res.data.trim().split("\n").filter(Boolean);
    if (!lines.length) return null;
    return lines[Math.floor(Math.random() * Math.min(5, lines.length))].trim();
  } catch (e) {
    return null;
  }
}

// ─── DOWNLOAD STRATEGIES ──────────────────────────────────────────────────────
// Each returns a yt-dlp command string. Tried in order until one works.
function buildStrategies(ytUrl, outputPath) {
  const base = `--cookies "${COOKIES_PATH}" --no-playlist`;
  const fmt = FORMAT_FLAGS;

  return [
    // 1. visionos + xff BD  (2026 default best client)
    `yt-dlp --extractor-args "youtube:player_client=visionos,web" --xff BD ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`,

    // 2. tv_embedded — bypass geo & age gates
    `yt-dlp --extractor-args "youtube:player_client=tv_embedded,tv" --xff BD ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`,

    // 3. tv_simply — lightweight TV client, different CDN path
    `yt-dlp --extractor-args "youtube:player_client=tv_simply,mweb" --xff BD ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`,

    // 4. ios + web_embedded — Apple client has different geo enforcement
    `yt-dlp --extractor-args "youtube:player_client=ios,web_embedded" --xff BD ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`,

    // 5. android_vr + tv_downgraded — VR client skips many restrictions
    `yt-dlp --extractor-args "youtube:player_client=android_vr,tv_downgraded" --xff BD ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`,

    // 6. ALL clients combined — try everything at once
    `yt-dlp --extractor-args "youtube:player_client=all" --xff BD ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`,
  ];
}

// Strategy 7: fresh BD proxy (async — needs proxy fetch first)
async function buildProxyStrategy(ytUrl, outputPath) {
  const base = `--cookies "${COOKIES_PATH}" --no-playlist`;
  const fmt = FORMAT_FLAGS;
  const proxy = await getFreshBDProxy();
  const proxyFlag = proxy ? `--proxy "socks5://${proxy}"` : `--xff BD`;
  return `yt-dlp --extractor-args "youtube:player_client=tv_embedded,tv_simply" ${proxyFlag} ${base} ${fmt} -o "${outputPath}" "${ytUrl}"`;
}

// ─── RUN A COMMAND ────────────────────────────────────────────────────────────
function runCmd(cmd, logs, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const hint = (stderr || err.message || "").slice(0, 250);
        logs.push(`   ↳ ❌ ${hint}`);
        return reject(err);
      }
      resolve();
    });
  });
}

// ─── GET VIDEO INFO ───────────────────────────────────────────────────────────
async function getVideoInfo(ytUrl, logs) {
  logs.push(`[YT] Fetching info: ${ytUrl}`);
  ensureCookies();

  // Try two clients for info fetch
  const infoClients = [
    `"youtube:player_client=visionos,tv_embedded"`,
    `"youtube:player_client=tv_simply,ios"`,
  ];

  for (const client of infoClients) {
    try {
      const cmd = `yt-dlp --extractor-args ${client} --xff BD --cookies "${COOKIES_PATH}" --dump-json --no-playlist "${ytUrl}"`;
      const info = await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 60000 }, (err, stdout) => {
          if (err) return reject(err);
          try {
            const lines = stdout.trim().split("\n");
            let parsed = null;
            for (const line of lines.reverse()) {
              try { parsed = JSON.parse(line); break; } catch (e) {}
            }
            if (!parsed) throw new Error("No valid JSON");
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      logs.push(`[YT] ✅ Title: ${info.title}`);
      return {
        title: info.title,
        description: info.description || "",
        thumbnail: info.thumbnail,
        duration: info.duration,
        videoId: info.id,
      };
    } catch (e) {
      logs.push(`[YT] Info client failed, trying next...`);
    }
  }
  throw new Error("Could not fetch video info with any client");
}

// ─── DOWNLOAD VIDEO (6+1 fallbacks) ──────────────────────────────────────────
async function downloadVideo(ytUrl, videoId, logs) {
  ensureCookies();
  const outputPath = path.join("/tmp", `${videoId}.mp4`);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const strategies = buildStrategies(ytUrl, outputPath);
  const total = strategies.length + 1; // +1 for proxy strategy

  for (let i = 0; i < strategies.length; i++) {
    logs.push(`[YT] Attempt ${i + 1}/${total} (${getStrategyName(i)})...`);
    try {
      await runCmd(strategies[i], logs);
      if (fs.existsSync(outputPath)) {
        const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
        logs.push(`[YT] ✅ Downloaded ${sizeMB}MB on attempt ${i + 1}`);
        return outputPath;
      }
    } catch (e) {
      logs.push(`[YT] Attempt ${i + 1} failed, trying next...`);
    }
  }

  // Final attempt: real BD proxy
  logs.push(`[YT] Attempt ${total}/${total} (BD Proxy)...`);
  try {
    const proxyCmd = await buildProxyStrategy(ytUrl, outputPath);
    await runCmd(proxyCmd, logs);
    if (fs.existsSync(outputPath)) {
      const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
      logs.push(`[YT] ✅ Downloaded ${sizeMB}MB via BD proxy`);
      return outputPath;
    }
  } catch (e) {
    logs.push(`[YT] BD proxy attempt also failed`);
  }

  throw new Error(`All ${total} download strategies failed. Video may be heavily geo-restricted.`);
}

function getStrategyName(i) {
  return [
    "visionos+web",
    "tv_embedded+tv",
    "tv_simply+mweb",
    "ios+web_embedded",
    "android_vr+tv_downgraded",
    "ALL clients",
  ][i] || `strategy-${i + 1}`;
}

// ─── DOWNLOAD THUMBNAIL ───────────────────────────────────────────────────────
async function downloadThumbnail(thumbnailUrl, videoId, logs) {
  logs.push(`[YT] Downloading thumbnail...`);
  const thumbPath = path.join("/tmp", `${videoId}_thumb.jpg`);
  try {
    const res = await axios.get(thumbnailUrl, { responseType: "arraybuffer", timeout: 15000 });
    fs.writeFileSync(thumbPath, res.data);
    logs.push(`[YT] ✅ Thumbnail saved`);
    return thumbPath;
  } catch (err) {
    logs.push(`[YT] ⚠️ Thumbnail failed: ${err.message}`);
    return null;
  }
}

module.exports = { getVideoInfo, downloadVideo, downloadThumbnail };
