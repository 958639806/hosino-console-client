import './style.css';
import { startApp } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('缺少应用挂载节点');
void startApp(root).catch(error => {
  const message = document.createElement('p');
  message.className = 'banner error';
  message.textContent = error instanceof Error ? error.message : '应用启动失败';
  root.replaceChildren(message);
});
