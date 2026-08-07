function openMenu() {
  const panel = document.getElementById("menuPanel");
  if (panel) panel.classList.add("open");
}

function closeMenu() {
  const panel = document.getElementById("menuPanel");
  if (panel) panel.classList.remove("open");
}

let toastTimer;

function showToast(message) {
  const toast = document.getElementById("toast");

  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 1800);
}

function goHome() {
  window.location.href = "/";
}

function goInfo() {
  window.location.href = "/info/";
}

function goCalendar() {
  window.location.href = "/calendar/";
}

function goLive() {
  window.location.href = "/live/";
}

function goBusking() {
  window.location.href = "/busking/";
}

function goNotice() {
  window.location.href = "/notice/";
}

function goQna() {
  window.location.href = "/qna/";
}

document.addEventListener("DOMContentLoaded", () => {
  const menuPanel = document.getElementById("menuPanel");

  if (menuPanel) {
    menuPanel.addEventListener("click", function(event) {
      if (event.target === this) {
        closeMenu();
      }
    });
  }
});
