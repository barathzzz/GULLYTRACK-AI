/* ==========================================================================
   GullyTrack AI — app.js
   Wires up the Start Analysis / Upload Clip controls to a live camera
   feed (or an uploaded video), draws a lightweight mock skeleton overlay
   on canvas, and drives the metric cards + coaching insight with a
   simulated biomechanics feed. Swap simulateTick() for a real pose model
   (e.g. MediaPipe Pose) later — everything downstream (DOM updates,
   gauges, alerts) already expects the same shape of data.
   ========================================================================== */

(() => {
    "use strict";

    const feed = document.getElementById("video-feed");
    const startBtn = document.getElementById("start-btn");
    const uploadBtn = document.getElementById("upload-btn");
    const videoWindow = document.querySelector(".video-window");
    const coachingPanel = document.querySelector(".coaching-panel");
    const insightEl = document.getElementById("coaching-insight");

    const metricEls = {
        jointAngle: document.querySelector('[data-metric="joint-angle"]'),
        injuryRisk: document.querySelector('[data-metric="injury-risk"]'),
        kneeAlignment: document.querySelector('[data-metric="knee-alignment"]'),
    };

    const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
    ).matches;

    const INSIGHTS = {
        safe: [
            "Your knee extension looks clean through the release phase. Keep this rhythm.",
            "Joint angle is tracking within the optimal band. Nice, repeatable form.",
            "Alignment is stable. This is a good rep to build muscle memory from.",
        ],
        warn: [
            "Your knee extension angle is overextended during the release phase. Soften your landing leg to protect your ACL.",
            "Knee is drifting inward on landing. Try widening your stance slightly on the next rep.",
            "Joint angle spiked outside the safe range. Slow the movement down and reset your base.",
        ],
    };

    let state = {
        running: false,
        mode: null, // "camera" | "clip"
        stream: null,
        videoEl: null,
        canvasEl: null,
        ctx: null,
        rafId: null,
        metricsTimer: null,
        insightTimer: null,
        points: [],
    };

    let fileInput = null;

    function ensureMediaElements() {
        if (state.videoEl) return;

        feed.classList.add("is-active");
        feed.querySelector(".camera-icon")?.setAttribute("aria-hidden", "true");

        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;

        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 640;

        feed.appendChild(video);
        feed.appendChild(canvas);

        state.videoEl = video;
        state.canvasEl = canvas;
        state.ctx = canvas.getContext("2d");
    }

    function teardownMediaElements() {
        if (state.stream) {
            state.stream.getTracks().forEach((track) => track.stop());
            state.stream = null;
        }
        state.videoEl?.remove();
        state.canvasEl?.remove();
        state.videoEl = null;
        state.canvasEl = null;
        state.ctx = null;
        feed.classList.remove("is-active", "is-scanning");
        feed.querySelectorAll(".feed-note").forEach((n) => n.remove());
    }

    function showFeedNote(text) {
        feed.querySelectorAll(".feed-note").forEach((n) => n.remove());
        const note = document.createElement("p");
        note.className = "feed-note";
        note.textContent = text;
        feed.appendChild(note);
    }

    async function startCamera() {
        ensureMediaElements();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user" },
                audio: false,
            });
            state.stream = stream;
            state.videoEl.srcObject = stream;
            await state.videoEl.play();
        } catch (err) {
            showFeedNote("Camera unavailable — showing simulated tracking");
        }
    }

    function startClip(file) {
        ensureMediaElements();
        const url = URL.createObjectURL(file);
        state.videoEl.srcObject = null;
        state.videoEl.src = url;
        state.videoEl.loop = true;
        state.videoEl.play().catch(() => {
            showFeedNote("Couldn't autoplay clip — tap to play");
        });
    }

    /* ---- mock pose overlay -------------------------------------------- */

    function initPoints() {
        // Rough humanoid stick-figure anchor points in canvas space
        const w = state.canvasEl.width;
        const h = state.canvasEl.height;
        state.points = [
            { x: w * 0.5, y: h * 0.18, r: 14 }, // head
            { x: w * 0.5, y: h * 0.34, r: 6 }, // chest
            { x: w * 0.32, y: h * 0.4, r: 5 }, // L shoulder
            { x: w * 0.68, y: h * 0.4, r: 5 }, // R shoulder
            { x: w * 0.28, y: h * 0.56, r: 5 }, // L elbow
            { x: w * 0.72, y: h * 0.56, r: 5 }, // R elbow
            { x: w * 0.5, y: h * 0.58, r: 6 }, // hip
            { x: w * 0.4, y: h * 0.78, r: 6 }, // L knee
            { x: w * 0.6, y: h * 0.78, r: 6 }, // R knee
            { x: w * 0.4, y: h * 0.96, r: 5 }, // L ankle
            { x: w * 0.6, y: h * 0.96, r: 5 }, // R ankle
        ];
    }

    const SKELETON_LINES = [
        [0, 1], [1, 2], [1, 3], [2, 4], [3, 5],
        [1, 6], [6, 7], [6, 8], [7, 9], [8, 10],
    ];

    function drawOverlay(jitter) {
        const { ctx, canvasEl } = state;
        if (!ctx) return;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

        const pts = state.points.map((p) => ({
            x: p.x + (jitter ? (Math.random() - 0.5) * 6 : 0),
            y: p.y + (jitter ? (Math.random() - 0.5) * 6 : 0),
            r: p.r,
        }));

        ctx.strokeStyle = "rgba(69, 214, 184, 0.65)";
        ctx.lineWidth = 2;
        SKELETON_LINES.forEach(([a, b]) => {
            ctx.beginPath();
            ctx.moveTo(pts[a].x, pts[a].y);
            ctx.lineTo(pts[b].x, pts[b].y);
            ctx.stroke();
        });

        ctx.fillStyle = "#45D6B8";
        pts.forEach((p) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function loopOverlay() {
        drawOverlay(true);
        state.rafId = requestAnimationFrame(loopOverlay);
    }

    /* ---- metrics simulation --------------------------------------------
       Replace this function with real pose-estimation output. It should
       return { jointAngle: number, injuryRisk: "Low"|"Moderate"|"High",
       kneeAligned: boolean } and everything else keeps working. */

    function simulateTick() {
        const jointAngle = Math.round(125 + Math.random() * 30); // 125–155°
        const optimal = jointAngle >= 130 && jointAngle <= 145;
        const kneeAligned = Math.random() > (optimal ? 0.15 : 0.55);
        const riskRoll = Math.random();
        let injuryRisk = "Low";
        if (!optimal || !kneeAligned) {
            injuryRisk = riskRoll > 0.55 ? "Moderate" : "Low";
        }
        if (!optimal && !kneeAligned) {
            injuryRisk = riskRoll > 0.5 ? "High" : "Moderate";
        }

        applyMetrics({ jointAngle, optimal, kneeAligned, injuryRisk });
    }

    function setGauge(el, pos, alert) {
        const card = el.closest(".metric-card");
        card.style.setProperty("--pos", String(Math.min(1, Math.max(0, pos))));
        card.classList.toggle("alert-card", alert);
        const statusEl = card.querySelector(".metric-status");
        if (statusEl) {
            statusEl.classList.toggle("status-safe", !alert);
            statusEl.classList.toggle("status-warn", alert);
        }
    }

    function applyMetrics({ jointAngle, optimal, kneeAligned, injuryRisk }) {
        // Joint angle
        metricEls.jointAngle.textContent = `${jointAngle}°`;
        setGauge(metricEls.jointAngle, (jointAngle - 100) / 60, !optimal);
        metricEls.jointAngle
            .closest(".metric-card")
            .querySelector(".metric-status").textContent = optimal
            ? "Optimal"
            : "Out of Range";

        // Injury risk
        metricEls.injuryRisk.textContent = injuryRisk;
        const riskPos = { Low: 0.15, Moderate: 0.55, High: 0.9 }[injuryRisk];
        const riskAlert = injuryRisk !== "Low";
        setGauge(metricEls.injuryRisk, riskPos, riskAlert);
        metricEls.injuryRisk
            .closest(".metric-card")
            .querySelector(".metric-status").textContent = riskAlert
            ? "Monitor"
            : "Stable";

        // Knee alignment
        metricEls.kneeAlignment.textContent = kneeAligned ? "Aligned" : "Deviated";
        setGauge(metricEls.kneeAlignment, kneeAligned ? 0.2 : 0.85, !kneeAligned);
        metricEls.kneeAlignment
            .closest(".metric-card")
            .querySelector(".metric-status").textContent = kneeAligned
            ? "Stable"
            : "Fix Posture";

        const isAlert = !optimal || !kneeAligned || riskIsElevated(injuryRisk);
        coachingPanel.classList.toggle("is-alert", isAlert);
    }

    function riskIsElevated(risk) {
        return risk === "Moderate" || risk === "High";
    }

    function rotateInsight() {
        const alert = coachingPanel.classList.contains("is-alert");
        const pool = alert ? INSIGHTS.warn : INSIGHTS.safe;
        const next = pool[Math.floor(Math.random() * pool.length)];
        insightEl.style.opacity = "0";
        setTimeout(() => {
            insightEl.textContent = `"${next}"`;
            insightEl.style.opacity = "1";
        }, prefersReducedMotion ? 0 : 200);
    }

    /* ---- lifecycle ------------------------------------------------------ */

    function startAnalysis(mode, file) {
        state.running = true;
        state.mode = mode;

        startBtn.textContent = "Stop Analysis";
        startBtn.classList.add("is-running");
        feed.classList.add("is-scanning");

        if (mode === "camera") {
            startCamera();
        } else {
            startClip(file);
        }

        initPoints();
        if (!prefersReducedMotion) {
            loopOverlay();
        } else {
            drawOverlay(false);
        }

        simulateTick();
        rotateInsight();
        state.metricsTimer = setInterval(simulateTick, 2200);
        state.insightTimer = setInterval(rotateInsight, 6000);
    }

    function stopAnalysis() {
        state.running = false;
        startBtn.textContent = "Start Analysis";
        startBtn.classList.remove("is-running");

        if (state.rafId) cancelAnimationFrame(state.rafId);
        clearInterval(state.metricsTimer);
        clearInterval(state.insightTimer);

        teardownMediaElements();
    }

    startBtn.addEventListener("click", () => {
        if (state.running) {
            stopAnalysis();
        } else {
            startAnalysis("camera");
        }
    });

    uploadBtn.addEventListener("click", () => {
        if (!fileInput) {
            fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = "video/*";
            fileInput.hidden = true;
            fileInput.addEventListener("change", () => {
                const file = fileInput.files?.[0];
                if (!file) return;
                if (state.running) stopAnalysis();
                startAnalysis("clip", file);
            });
            document.body.appendChild(fileInput);
        }
        fileInput.click();
    });
})();