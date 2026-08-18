import "./style.css";

const image = document.querySelector("#image");
const waiting = document.querySelector("#waiting");

let currentUrl = null;

window.viewer.onConnection((connected) => {
  if (connected) {
    if (!currentUrl) {
      waiting.style.display = "block";
      waiting.textContent = "تم الاتصال بالأدمن، بانتظار صورة...";
    }
    return;
  }

  if (!currentUrl) {
    waiting.style.display = "block";
    waiting.textContent = "جاري البحث عن جهاز الأدمن...";
  }
});

window.viewer.onImage((data) => {
  const nextUrl = URL.createObjectURL(
    new Blob([data.buffer], { type: data.mime || "image/jpeg" })
  );

  const previousUrl = currentUrl;
  currentUrl = nextUrl;

  image.src = nextUrl;
  image.style.display = "block";
  waiting.style.display = "none";

  if (previousUrl) {
    setTimeout(() => URL.revokeObjectURL(previousUrl), 1000);
  }
});
