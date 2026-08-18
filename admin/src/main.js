import "./style.css";

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <small>IMAGEBOARD LAN</small>
        <h1>لوحة الأدمن</h1>
        <p>اسحب الصورة وأسقطها لإرسالها مباشرة إلى شاشة العرض.</p>
      </div>
      <div class="status">
        <i id="dot"></i>
        <span id="status">في انتظار Viewer</span>
      </div>
    </header>

    <section id="drop" class="drop">
      <div class="plus">＋</div>
      <h2>اسحب الصورة هنا</h2>
      <p>أو اختر صورة من Windows</p>
      <button id="pick">اختيار صورة</button>
      <input id="file" type="file" accept="image/*" hidden>
    </section>

    <section class="info">
      <div>
        <label>Viewer</label>
        <strong id="viewer">غير متصل</strong>
      </div>
      <div>
        <label>عنوان الأدمن</label>
        <strong id="ip">...</strong>
      </div>
      <div>
        <label>WebSocket</label>
        <strong id="ws">...</strong>
      </div>
    </section>

    <div id="msg">جاهز</div>
  </main>
`;

const drop = document.querySelector("#drop");
const pick = document.querySelector("#pick");
const file = document.querySelector("#file");
const msg = document.querySelector("#msg");

let connected = false;
let busy = false;

function setStatus(value) {
  connected = value;
  document.querySelector("#dot").className = value ? "on" : "";
  document.querySelector("#status").textContent = value
    ? "Viewer متصل"
    : "في انتظار Viewer";
  document.querySelector("#viewer").textContent = value
    ? "🟢 متصل"
    : "🟡 غير متصل";
}

async function send(fileToSend) {
  if (!fileToSend || busy) {
    return;
  }

  if (!fileToSend.type.startsWith("image/")) {
    msg.textContent = "الملف ليس صورة";
    return;
  }

  if (!connected) {
    msg.textContent = "لا يوجد Viewer متصل";
    return;
  }

  busy = true;
  pick.disabled = true;
  msg.textContent = "جارٍ الإرسال...";

  try {
    const buffer = await fileToSend.arrayBuffer();
    const result = await window.imageBoard.sendImage(
      buffer,
      fileToSend.name,
      fileToSend.type
    );

    msg.textContent = result.sent
      ? `تم إرسال ${fileToSend.name} إلى ${result.count} شاشة`
      : "لم يتم الإرسال";
  } catch (error) {
    msg.textContent = `فشل الإرسال: ${error?.message || error}`;
  } finally {
    busy = false;
    pick.disabled = false;
  }
}

pick.onclick = () => file.click();

file.onchange = () => {
  send(file.files?.[0]);
  file.value = "";
};

for (const eventName of ["dragenter", "dragover"]) {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.add("active");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.remove("active");
  });
}

drop.ondrop = (event) => send(event.dataTransfer.files?.[0]);

window.imageBoard.onStatus(setStatus);

window.imageBoard
  .getNetworkInfo()
  .then((info) => {
    document.querySelector("#ip").textContent = info?.address || "غير معروف";
    document.querySelector("#ws").textContent = info?.wsPort
      ? `TCP ${info.wsPort}`
      : "غير متاح";
  })
  .catch((error) => {
    document.querySelector("#ip").textContent = "خطأ";
    document.querySelector("#ws").textContent = "خطأ";
    msg.textContent = `تعذر قراءة إعدادات الشبكة: ${error?.message || error}`;
  });

setStatus(false);
