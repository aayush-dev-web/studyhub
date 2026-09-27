/* ============================================================================
 * StudyHub — profile page: avatar upload + live ID card verification
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth();
  if (!session) return;

  const profile = await loadIdentity(session);
  if (!profile) return;

  document.getElementById("email-readonly").value = session.user.email || session.user.phone || "";

  initAvatarUpload(session);
  initBasicForm(session, profile);
  renderVerifyPanel(profile);
  initScanner(session, profile);
});

/* ------------------------------------------------------------- alerts --- */

const pageAlert = () => document.getElementById("page-alert");

/* ------------------------------------------------------ avatar upload --- */

function initAvatarUpload(session) {
  const btn = document.getElementById("avatar-btn");
  const input = document.getElementById("avatar-input");

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showAlert(pageAlert(), "error", "Please choose an image under 5 MB.");
      input.value = "";
      return;
    }

    btn.disabled = true;
    clearAlert(pageAlert());

    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, cacheControl: "3600" });
      if (uploadError) throw uploadError;

      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const avatarUrl = pub.publicUrl;

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: avatarUrl })
        .eq("user_id", session.user.id);
      if (updateError) throw updateError;

      renderAvatarEverywhere(avatarUrl, document.querySelector("[data-identity-name]")?.textContent || "");
      showAlert(pageAlert(), "success", "Profile photo updated ✓");
    } catch (err) {
      console.debug("[StudyHub] avatar upload failed:", err);
      showAlert(pageAlert(), "error", friendlyError(err));
    } finally {
      btn.disabled = false;
      input.value = "";
    }
  });
}

/* ------------------------------------------------------- basic details -- */

function initBasicForm(session, profile) {
  const form = document.getElementById("basic-form");
  const fullName = document.getElementById("full-name");
  const phone = document.getElementById("phone");
  const saveBtn = document.getElementById("basic-save-btn");

  fullName.value = profile.full_name || "";
  phone.value = profile.phone || "";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(pageAlert());

    if (!fullName.value.trim()) {
      showAlert(pageAlert(), "error", "Please enter your full name.");
      fullName.focus();
      return;
    }

    setLoading(saveBtn, true, "Saving…");

    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName.value.trim(), phone: phone.value.trim() || null })
        .eq("user_id", session.user.id);
      if (error) throw error;

      document.querySelectorAll("[data-identity-name]").forEach((el) => (el.textContent = fullName.value.trim()));
      showAlert(pageAlert(), "success", "Saved ✓");
    } catch (err) {
      showAlert(pageAlert(), "error", friendlyError(err));
    } finally {
      setLoading(saveBtn, false);
    }
  });
}

/* --------------------------------------------------------- verify panel - */

function renderVerifyPanel(profile) {
  const badge = document.getElementById("identity-badge");
  const views = {
    not_submitted: document.getElementById("verify-start"),
    pending: document.getElementById("verify-pending"),
    verified: document.getElementById("verify-verified"),
    rejected: document.getElementById("verify-rejected"),
  };

  Object.values(views).forEach((el) => (el.hidden = true));
  const status = profile.identity_status || "not_submitted";
  (views[status] || views.not_submitted).hidden = false;

  const badgeText = {
    not_submitted: "Not verified yet",
    pending: "Pending review",
    verified: "Verified",
    rejected: "Needs another scan",
  };
  const badgeClass = {
    not_submitted: "id-badge id-badge--muted",
    pending: "id-badge id-badge--pending",
    verified: "id-badge id-badge--verified",
    rejected: "id-badge id-badge--rejected",
  };
  badge.textContent = badgeText[status] || badgeText.not_submitted;
  badge.className = badgeClass[status] || badgeClass.not_submitted;
}

async function refreshVerifyPanelFromServer(session) {
  const { data } = await supabase
    .from("profiles")
    .select("identity_status")
    .eq("user_id", session.user.id)
    .maybeSingle();

  const { data: latest } = await supabase
    .from("identity_verifications")
    .select("created_at, status, review_note")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) renderVerifyPanel(data);

  if (latest) {
    const dateText = new Date(latest.created_at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const pendingDate = document.getElementById("pending-date");
    const verifiedDate = document.getElementById("verified-date");
    const rejectedNote = document.getElementById("rejected-note");
    if (pendingDate) pendingDate.textContent = dateText;
    if (verifiedDate) verifiedDate.textContent = dateText;
    if (rejectedNote && latest.review_note) {
      rejectedNote.textContent = latest.review_note;
    }
  }
}

/* ------------------------------------------------------------- scanner -- */

function initScanner(session, profile) {
  const openBtns = [document.getElementById("scan-btn"), document.getElementById("rescan-btn")].filter(Boolean);
  const overlay = document.getElementById("scan-overlay");
  const closeBtn = document.getElementById("scan-close");
  const video = document.getElementById("scan-video");
  const canvas = document.getElementById("scan-canvas");
  const hint = document.getElementById("scan-hint");
  const foundBox = document.getElementById("scan-found");
  const foundName = document.getElementById("found-name");
  const foundInstitution = document.getElementById("found-institution");
  const foundClass = document.getElementById("found-class");

  let stream = null;
  let scanTimer = null;
  let stopped = false;
  let institutionsList = [];
  const SCAN_INTERVAL_MS = 1400;
  const MAX_SCAN_MS = 45000;

  async function loadInstitutions() {
    if (institutionsList.length) return institutionsList;
    try {
      const { data, error } = await supabase.from("institutions").select("id, name");
      if (error) throw error;
      institutionsList = data || [];
    } catch (err) {
      console.debug("[StudyHub] institutions load for OCR match failed:", err.message);
    }
    return institutionsList;
  }

  /* ------------------------------------------------- text-field parsing */

  function parseIdCardText(raw) {
    const text = raw.replace(/\r/g, "");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let name = null;
    let classLevel = null;
    let expiryDate = null;

    for (const line of lines) {
      const m = line.match(/name\s*[:\-]\s*(.+)/i);
      if (m && !name) name = cleanField(m[1]);
    }
    if (!name) {
      // Fallback: the longest mostly-alphabetic, mostly-uppercase line that
      // isn't obviously a label ("STUDENT ID CARD", school name, etc).
      const candidates = lines.filter(
        (l) =>
          /^[A-Z][A-Z.'\- ]{3,40}$/.test(l) &&
          !/CARD|SCHOOL|COLLEGE|INSTITUTE|ACADEMY|UNIVERSITY|VALID|CLASS|GRADE/i.test(l)
      );
      if (candidates.length) name = cleanField(candidates.sort((a, b) => b.length - a.length)[0]);
    }

    const classMatch = text.match(/(class|grade)\s*[:\-]?\s*([0-9]{1,2}(st|nd|rd|th)?|[ivxlcdm]+)/i);
    if (classMatch) {
      classLevel = /^[0-9]/.test(classMatch[2]) ? `Grade ${classMatch[2].replace(/[a-z]/gi, "")}` : classMatch[2];
    }

    const dateMatch = text.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/);
    const yearOnlyMatch = text.match(/(valid|expiry|exp|till|until|upto)\D{0,6}(20\d{2})/i);
    if (dateMatch) {
      expiryDate = normalizeDate(dateMatch[1]);
    } else if (yearOnlyMatch) {
      expiryDate = `${yearOnlyMatch[2]}-12-31`;
    }

    const institutionRaw = lines.find((l) => /school|college|institute|academy|university/i.test(l)) || null;
    const institutionMatch = matchInstitution(text, institutionsList);

    return {
      name,
      classLevel,
      expiryDate,
      institutionRaw,
      institutionId: institutionMatch?.id || null,
      institutionName: institutionMatch?.name || institutionRaw,
    };
  }

  function cleanField(value) {
    return value
      .replace(/[^A-Za-z.'\- ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function normalizeDate(raw) {
    const parts = raw.split(/[\/\-.]/).map((p) => p.trim());
    if (parts.length !== 3) return null;
    let [a, b, c] = parts;
    if (c.length === 2) c = (Number(c) > 50 ? "19" : "20") + c;
    // Assume DD/MM/YYYY, the common non-US convention on ID cards.
    const day = a.padStart(2, "0");
    const month = b.padStart(2, "0");
    if (Number(month) > 12) return null;
    return `${c}-${month}-${day}`;
  }

  function matchInstitution(text, list) {
    const lower = text.toLowerCase();
    let best = null;
    for (const inst of list) {
      if (inst.name && lower.includes(inst.name.toLowerCase())) {
        if (!best || inst.name.length > best.name.length) best = inst;
      }
    }
    return best;
  }

  function isGoodEnough(fields) {
    return Boolean(fields.name) && Boolean(fields.institutionId || fields.classLevel);
  }

  /* --------------------------------------------------------- camera loop */

  async function openScanner() {
    stopped = false;
    overlay.hidden = false;
    hint.textContent = "Hold your ID flat inside the frame, in good light.";
    foundBox.hidden = true;
    foundName.textContent = "—";
    foundInstitution.textContent = "—";
    foundClass.textContent = "—";

    await loadInstitutions();

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (firstErr) {
        // Most laptops only have a front-facing camera and can reject a
        // strict "environment" request outright — fall back to any camera.
        console.debug("[StudyHub] environment camera unavailable, trying default:", firstErr.message);
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      const deniedMsg =
        err.name === "NotAllowedError"
          ? "Camera access was blocked. Allow camera access for this site in your browser's address bar, then try again."
          : "Couldn't access your camera. Check that no other app is using it, then try again.";
      hint.textContent = deniedMsg;
      showAlert(pageAlert(), "error", deniedMsg);
      console.debug("[StudyHub] camera error:", err);
      return;
    }

    const deadline = Date.now() + MAX_SCAN_MS;
    let attempt = 0;

    scanTimer = setInterval(async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        hint.textContent = "Couldn't read enough from the ID. Try better lighting and hold it steady.";
        stopScanLoopOnly();
        return;
      }

      attempt += 1;
      hint.textContent = "Scanning… keep it steady.";

      try {
        const canvasCtx = canvas.getContext("2d");
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const {
          data: { text },
        } = await Tesseract.recognize(canvas, "eng");

        const fields = parseIdCardText(text);

        if (fields.name || fields.institutionName || fields.classLevel) {
          foundBox.hidden = false;
          foundName.textContent = fields.name || "—";
          foundInstitution.textContent = fields.institutionName || "—";
          foundClass.textContent = fields.classLevel || "—";
        }

        if (isGoodEnough(fields)) {
          await finishScan(fields, canvas);
        }
      } catch (err) {
        console.debug("[StudyHub] OCR pass failed:", err.message);
      }
    }, SCAN_INTERVAL_MS);
  }

  function stopScanLoopOnly() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
  }

  function closeScanner() {
    stopped = true;
    stopScanLoopOnly();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    overlay.hidden = true;
  }

  async function finishScan(fields, capturedCanvas) {
    stopped = true;
    stopScanLoopOnly();
    hint.textContent = "Got it — submitting for review…";

    try {
      const blob = await new Promise((resolve) => capturedCanvas.toBlob(resolve, "image/jpeg", 0.85));
      const path = `${session.user.id}/${Date.now()}.jpg`;

      const { error: uploadError } = await supabase.storage.from("id-cards").upload(path, blob, {
        contentType: "image/jpeg",
      });
      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from("identity_verifications").insert({
        user_id: session.user.id,
        role_at_submission: profile.role,
        image_path: path,
        extracted_full_name: fields.name,
        extracted_institution_id: fields.institutionId,
        extracted_institution_raw: fields.institutionRaw,
        extracted_class_level: fields.classLevel,
        extracted_expiry_date: fields.expiryDate,
      });
      if (insertError) throw insertError;

      closeScanner();
      showAlert(
        pageAlert(),
        "success",
        "ID submitted — your details were filled in automatically. An admin will confirm it shortly."
      );
      await refreshVerifyPanelFromServer(session);

      // Reflect any auto-filled fields in the Basic details form too.
      if (fields.name) document.getElementById("full-name").value = fields.name;
    } catch (err) {
      console.debug("[StudyHub] ID submission failed:", err);
      hint.textContent = "Something went wrong submitting your ID. Please try again.";
      showAlert(pageAlert(), "error", friendlyError(err));
      stopped = false;
    }
  }

  openBtns.forEach((btn) => btn.addEventListener("click", openScanner));
  closeBtn.addEventListener("click", closeScanner);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeScanner();
  });
}
