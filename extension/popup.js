// PinBoardLock — 工具栏弹窗
(() => {
  const style = document.createElement('style');
  style.textContent = PBLPicker.css;
  document.head.appendChild(style);
  const picker = PBLPicker.mount(document.getElementById('root'));
  setTimeout(() => picker.focus(), 50);
})();
