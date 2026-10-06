import './styles.css';

const bootstrap = __APP_TARGET__ === 'macos'
  ? import('./bootstrap-desktop.js')
  : import('./bootstrap-web.js');
void bootstrap.then(module => module.start()).catch(error => {
  const root = document.getElementById('root')!;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = `应用启动失败：${error instanceof Error ? error.message : String(error)}。请重新打开应用。`;
  root.replaceChildren(message);
});
