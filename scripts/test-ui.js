/* Browser UI smoke test against StubBackend (never contacts a live inference server).
 * Run: CHROMIUM_PATH=/usr/bin/chromium node scripts/test-ui.js */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "../ui");
  const server = http.createServer(async (req, res) => {
    const filename = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const content = await fs.readFile(filename);
      res.setHeader(
        "Content-Type",
        filename.endsWith(".js") ? "application/javascript"
          : filename.endsWith(".css") ? "text/css"
          : "text/html"
      );
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/index.html`;

    // 1. Halogen status: vision OFF warning vs vision ready KV pool/cache display.
    await page.goto(url + "#tab3");
    await page.waitForFunction(() => document.querySelector("#exec-summary").textContent.length > 0);
    await page.evaluate(() => { StubBackend._state.visionEnabled = false; });
    await page.locator("#btn-health").click();
    await page.waitForFunction(() => document.querySelector("#vision-pill").textContent === "vision OFF");
    assert.equal(await page.locator("#vision-warning").isHidden(), false);
    assert.match(await page.locator("#vision-warning").textContent(), /HALOGEN_VISION_TOWER=1/);

    await page.evaluate(() => { StubBackend._state.visionEnabled = true; });
    await page.locator("#btn-health").click();
    await page.waitForFunction(() => document.querySelector("#vision-pill").textContent === "vision ready");
    assert.equal(await page.locator("#vision-warning").isHidden(), true);
    assert.match(await page.locator("#hx-kvpool").textContent(), /524,288/);

    // 2. Sampling presets: greedy disables extra fields; Qwen presets populate; server-default omits all.
    assert.ok(await page.locator("#p-topp").isDisabled());
    assert.deepEqual(
      await page.evaluate(() => HalogenConfig.samplingFields(settings)),
      { temperature: 0 }
    );
    await page.locator("#p-preset").selectOption("qwen-non-thinking");
    assert.equal(await page.locator("#p-temp").inputValue(), "0.7");
    assert.equal(await page.locator("#p-topp").inputValue(), "0.8");
    assert.equal(await page.locator("#p-topk").inputValue(), "20");
    assert.equal(await page.locator("#p-presence-penalty").inputValue(), "1.5");
    assert.ok(!(await page.locator("#p-topp").isDisabled()));
    assert.deepEqual(
      await page.evaluate(() => HalogenConfig.samplingFields(settings)),
      { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, repetition_penalty: 1 }
    );
    await page.locator("#p-preset").selectOption("server-default");
    assert.ok(await page.locator("#p-temp").isDisabled());
    assert.deepEqual(await page.evaluate(() => HalogenConfig.samplingFields(settings)), {});
    await page.locator("#p-preset").selectOption("greedy");

    // 3. Execution presets & thinking controls.
    assert.equal(await page.locator("#hx-max-thinking-field").isHidden(), true);
    await page.locator("#hx-thinking").selectOption("low");
    assert.equal(await page.locator("#hx-max-thinking-field").isHidden(), false);
    await page.locator("#hx-max-thinking").fill("2048");
    await page.locator("#hx-max-thinking").blur();
    await page.locator("#hx-cache-mode").selectOption("fork");
    page.once("dialog", dialog => dialog.accept("Fork low"));
    await page.locator("#btn-exec-preset-save").click();
    await page.locator("#hx-thinking").selectOption("none");
    await page.locator("#hx-cache-mode").selectOption("standard");
    await page.locator("#exec-preset").selectOption("Fork low");
    assert.equal(await page.locator("#hx-thinking").inputValue(), "low");
    assert.equal(await page.locator("#hx-max-thinking").inputValue(), "2048");
    assert.equal(await page.locator("#hx-cache-mode").inputValue(), "fork");

    // 4. Budget presets & custom apply.
    await page.locator('.budget-preset[data-pixels="2073600"]').click();
    assert.equal(await page.locator("#budget-mode").inputValue(), "custom");
    assert.equal(await page.evaluate(() => renderTargetPx()), 2073600);
    await page.locator("#budget-mode").selectOption("auto");
    await page.locator("#budget-apply").click();
    assert.equal(await page.evaluate(() => renderTargetPx()), 3686400);

    await page.reload();
    await page.waitForFunction(() => document.querySelector("#hx-cache-mode").value === "fork");

    // 5. Streaming run with prompt_progress, throttled Markdown, MTP + cache-hit + fork stats, and recovery.
    const result = await page.evaluate(async () => {
      let paints = 0;
      let progressSeen = false;
      const originalRender = Markdown.render;
      Markdown.render = text => { paints++; return originalRender(text); };

      const origStream = Backend.streamBatch;
      Backend.streamBatch = async function* (args) {
        yield { type: "progress", progress: { total: 2400, cache: 256, processed: 1200, time_ms: 400 } };
        for (let i = 0; i < 80; i++) {
          yield { type: "output", text: `word${i} ` };
          await new Promise(r => setTimeout(r, 2));
        }
        yield {
          type: "stats",
          stats: GenerationStats.normalize(
            { prompt_n: 2144, cache_n: 256, prompt_ms: 800, prompt_per_second: 2680, predicted_n: 80, predicted_per_second: 85.0, draft_n: 100, draft_n_accepted: 80 },
            "request",
            { prompt_tokens: 2400, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 256 }, completion_tokens_details: { reasoning_tokens: 24, reasoning_closed_by: "answer_room" } },
            "used"
          ),
        };
      };

      state.pages = [{ index: 0, label: "test page" }];
      state.pdfName = "test.pdf";
      const panel = buildRunPanel(0, [0]);
      const obs = new MutationObserver(() => {
        if (panel.querySelector(".rp-status").textContent.includes("prefill")) progressSeen = true;
      });
      obs.observe(panel, { subtree: true, childList: true, characterData: true });
      document.querySelector("#run-panels").replaceChildren(panel);
      document.querySelector("#run-panels").hidden = false;
      document.querySelector("#run-empty").hidden = true;
      const run = {
        panels: [panel], outputs: [""], done: [false], controllers: [null], speeds: [], prefill: [], stats: [],
        batches: [[0]], instruction: "Transcribe.", model: "halogen-qwen3.8-flash-next",
        maxTokens: 16384, thinkingEffort: "low", maxThinkingTokens: 2048, cacheMode: "fork",
        settingsSnapshot: { ...settings }, warmReply: "Ready.", activeHandle: "docproc4-test",
        pdfName: "test.pdf", pageCount: 1,
      };
      state.currentRun = run;
      state.running = true;
      selectTab("tab4");
      await runBatch(0, [0], "Transcribe.", run);
      obs.disconnect();
      await recoveryQueue;
      await new Promise(requestAnimationFrame);
      Backend.streamBatch = origStream;

      const output = run.outputs[0];
      const statsText = panel.querySelector(".rp-stats").textContent;
      const dCache = document.querySelector("#d-cache").textContent;
      const dMtp = document.querySelector("#d-mtp").textContent;
      const rec = await Backend.readRecovery();
      restoreRun(rec);
      return {
        paints,
        progressSeen,
        output,
        statsText,
        restoredStats: document.querySelector(".rp-stats").textContent,
        dCache,
        dMtp,
        rec,
      };
    });

    assert.ok(result.progressSeen, "Expected prompt_progress prefill status update");
    assert.equal(result.output, Array.from({ length: 80 }, (_, i) => `word${i} `).join(""));
    assert.ok(result.paints < 20, `Expected fewer than 20 Markdown renders, got ${result.paints}`);
    assert.match(result.statsText, /2,400 tok \(256 cached, 11%\)/);
    assert.match(result.statsText, /MTP 80\.0% \(80\/100\)/);
    assert.match(result.statsText, /thinking 24 tok \(closed by answer_room\)/);
    assert.match(result.statsText, /fork used/);
    assert.equal(result.restoredStats, result.statsText);
    assert.equal(result.dCache, "11%");
    assert.equal(result.dMtp, "80.0%");
    assert.equal(result.rec.stats[0].specAcceptance, 80);

    // 6. Reload and verify recovery banner offers restore.
    await page.reload();
    await page.waitForFunction(() => !document.querySelector("#recovery-banner").hidden);
    assert.match(await page.locator("#recovery-text").textContent(), /test\.pdf: 1 of 1 batch/);
    assert.deepEqual(errors, []);
    console.log(`UI checks passed: Halogen status, vision toggle, sampling & exec presets, budget presets, prompt_progress, MTP/cache telemetry, recovery; ${result.paints} Markdown renders for 80 fragments.`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
