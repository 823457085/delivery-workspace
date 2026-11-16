/** Plugin-owned confirmation; sandboxed application frames do not support window.confirm. */
export function confirmAction(message: string): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'plugin-confirm';
    const title = document.createElement('h2'); title.textContent = '确认操作';
    const text = document.createElement('p'); text.textContent = message;
    const footer = document.createElement('footer');
    const cancel = document.createElement('button'); cancel.textContent = '取消';
    const accept = document.createElement('button'); accept.textContent = '确认执行'; accept.className = 'primary';
    const finish = (value: boolean) => { dialog.close(); dialog.remove(); resolve(value); };
    cancel.onclick = () => finish(false); accept.onclick = () => finish(true);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    footer.append(cancel, accept); dialog.append(title, text, footer); document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
