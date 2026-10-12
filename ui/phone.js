(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("pair-config").textContent), path = window.location.pathname.replace(/\/$/, ""), deadline = Date.now() + config.remaining * 1000, busy = false, finished = false;
  var form = document.getElementById("form"), value = document.getElementById("value"), password = document.getElementById("password"), message = document.getElementById("message"), submit = document.getElementById("submit"), devices = document.getElementById("devices");
  var captchaImage = document.getElementById("captcha"), captchaFrame = document.getElementById("captcha-frame"), captchaStatus = document.getElementById("captcha-status"), captchaRefresh = document.getElementById("captcha-refresh"), captchaCode = document.getElementById("captcha-code"), captchaReady = config.scope !== "register", captchaLoading = false;
  function updateButtons() { submit.disabled = busy || finished || !captchaReady; captchaRefresh.disabled = busy || finished || captchaLoading; }
  function request(action, body, done) {
    var xhr = new XMLHttpRequest(); xhr.open(body ? "POST" : "GET", path + "/" + action, true); xhr.timeout = 22000;
    if (body) xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function () { var data; try { data = JSON.parse(xhr.responseText); } catch (ignore) { data = {error: "连接失败，请检查局域网"}; } done(xhr.status >= 200 && xhr.status < 300, data, xhr.status); };
    xhr.onerror = xhr.ontimeout = function () { done(false, {error: action === "captcha" ? "验证码连接失败，请点击换一张重试" : "连接中断，请在电视查看操作结果"}, 0); }; xhr.send(body ? JSON.stringify(body) : null);
  }
  function captchaFailed(text, status) {
    captchaLoading = false; captchaReady = false; captchaImage.hidden = true;
    captchaFrame.setAttribute("aria-busy", "false"); captchaFrame.classList.add("is-error"); captchaStatus.hidden = false; captchaStatus.textContent = text;
    if (status === 404 || status === 410) { finished = true; form.hidden = true; password.value = ""; message.textContent = text; }
    updateButtons();
  }
  function captcha() {
    if (captchaLoading || busy || finished) return;
    captchaLoading = true; captchaReady = false; captchaCode.value = ""; captchaImage.hidden = true; captchaImage.removeAttribute("src");
    captchaFrame.setAttribute("aria-busy", "true"); captchaFrame.classList.remove("is-error"); captchaStatus.hidden = false; captchaStatus.textContent = "正在加载验证码…"; updateButtons();
    request("captcha", null, function (ok, data, status) {
      if (finished) return;
      if (!ok || !data.image) { captchaFailed(data.error || "验证码加载失败，请点击换一张重试", status); return; }
      captchaImage.onload = function () {
        if (finished) return;
        captchaLoading = false; captchaReady = true; captchaFrame.setAttribute("aria-busy", "false"); captchaStatus.hidden = true; captchaImage.hidden = false; updateButtons();
      };
      captchaImage.onerror = function () { if (!finished) captchaFailed("验证码图片加载失败，请点击换一张重试", 0); };
      captchaImage.src = data.image;
    });
  }
  function result(ok, data) {
    busy = false; updateButtons();
    if (data.deviceLimit && data.devices) {
      form.hidden = true; devices.hidden = false; devices.innerHTML = ""; message.textContent = "登录设备已达上限，选择一台下线并登录此电视。";
      data.devices.forEach(function (device) {
        var button = document.createElement("button"); button.type = "button"; button.className = "device"; button.textContent = device.deviceName || "未知设备";
        var description = document.createElement("small"); description.textContent = "下线此设备并登录电视"; button.appendChild(description); button.disabled = !device.tokenTail;
        button.onclick = function () { if (busy) return; busy = true; updateButtons(); message.textContent = "正在登录…"; request("resolve", {scope: config.scope, kickTail: device.tokenTail}, result); }; devices.appendChild(button);
      }); return;
    }
    message.textContent = data.message || data.error || "提交失败";
    if (ok && data.success) { finished = true; form.hidden = true; devices.hidden = true; password.value = ""; value.value = ""; if (config.scope === "search") message.textContent = "关键词已提交，电视会自动开始搜索。"; }
    else if (data.error && !/请输入|请选择|输入无效/.test(data.error)) { finished = true; form.hidden = true; devices.hidden = true; password.value = ""; message.textContent += "\n请在电视刷新二维码后重试。"; }
    updateButtons();
  }
  document.getElementById("pair-code").textContent = config.code;
  if (config.scope !== "search") {
    document.getElementById("title").textContent = config.scope === "register" ? "扫码注册" : "扫码登录";
    document.getElementById("intro").textContent = "在手机填写明明音乐账号，完成后电视会自动同步。";
    document.getElementById("user-label").textContent = config.scope === "register" ? "用户名" : "用户名或邮箱";
    document.getElementById("account-fields").hidden = false; password.required = true; value.autocomplete = "username";
    submit.textContent = config.scope === "register" ? "注册并登录电视" : "登录电视";
    if (config.scope === "register") { password.autocomplete = "new-password"; document.getElementById("register-fields").hidden = false; document.getElementById("captcha-code").required = true; document.getElementById("captcha-refresh").onclick = captcha; captcha(); }
  } else { document.getElementById("title").textContent = "扫码搜索"; document.getElementById("intro").textContent = "输入关键词并点击搜索，电视会自动显示搜索结果。"; value.placeholder = "歌曲、歌手或专辑"; value.maxLength = 100; submit.textContent = "搜索"; }
  form.onsubmit = function (event) {
    event.preventDefault(); if (busy || finished || !captchaReady) return;
    busy = true; updateButtons(); message.textContent = "正在提交…";
    var body = {scope: config.scope}; if (config.scope === "search") body.value = value.value;
    else { body.username = value.value; body.password = password.value; if (config.scope === "register") body.captchaCode = document.getElementById("captcha-code").value; }
    request("submit", body, result);
  };
  function tick() {
    var remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); document.getElementById("expiry").textContent = Math.floor(remaining / 60) + ":" + (remaining % 60 < 10 ? "0" : "") + remaining % 60 + " 后失效";
    if (!remaining && !finished) { finished = true; form.hidden = true; devices.hidden = true; password.value = ""; message.textContent = "二维码已过期，请在电视刷新。"; updateButtons(); }
  }
  tick(); window.setInterval(tick, 1000);
}());
