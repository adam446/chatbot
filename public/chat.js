(function () {
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();

  var token = script.getAttribute("data-token");
  var origin = script.src
    ? new URL(script.src).origin
    : window.location.origin;

  var iframe = document.createElement("iframe");
  iframe.src = origin;
  iframe.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "right:24px",
    "width:400px",
    "height:600px",
    "border:none",
    "border-radius:12px",
    "box-shadow:0 4px 24px rgba(0,0,0,0.2)",
    "z-index:2147483647",
  ].join(";");
  iframe.setAttribute("allow", "microphone");

  iframe.addEventListener("load", function () {
    iframe.contentWindow.postMessage(
      { type: "auth-token", token: token },
      origin
    );
  });

  document.body.appendChild(iframe);
})();