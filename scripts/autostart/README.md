# 开机/登录自启（用户级，无需管理员）

适用于**低权限**环境（公司锁定的 Windows、统信 UOS / 麒麟等信创桌面）。
全部走**当前用户**的自启机制，不写系统目录、不装服务、不需要管理员/root。

> 前提：目标机器已安装对应架构的 **Node.js** 并加入 PATH。
> 本项目依赖全为纯 JS（无原生 `.node`），`node_modules` 可跨平台/跨架构直接拷贝，
> 只要 Node 运行时是目标平台对应版本即可（如统信 UOS 海光 C86 用标准 x86_64 版 Node）。

---

## 统信 UOS / 麒麟 / Deepin 等 Linux

```bash
# 安装登录自启（并立即启动一次）
bash scripts/autostart/install-autostart.sh

# 手动启动 / 停止
bash scripts/autostart/start-daemon.sh
bash scripts/autostart/stop-daemon.sh

# 卸载登录自启（并停止当前实例）
bash scripts/autostart/uninstall-autostart.sh
```

- 自启项写入 `~/.config/autostart/proxy-inspector.desktop`，登录桌面后静默后台启动。
- 后台运行、无终端窗口、关终端不退出；进程号记录在项目根 `.proxy-inspector.pid`。
- 日志按天写入项目根 `logs/proxy-YYYYMMDD.log`。
- 防重复启动：已在运行则不再拉起。

## Windows（公司电脑，低权限）

```bat
:: 安装登录自启（无黑窗口，并立即启动一次）
scripts\autostart\install-autostart-win.cmd

:: 卸载登录自启
scripts\autostart\uninstall-autostart-win.cmd
```

- 自启项写入当前用户启动文件夹
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\proxy-inspector.vbs`，
  用 VBS 包装实现**无黑窗口**后台启动。
- 日志写入项目根 `logs\proxy.log`。
- 停止：任务管理器结束 `node.exe`，或注销/重启。

---

## 怎么确认它在运行

- 打开面板 **http://127.0.0.1:28900**，能打开即在运行。
- Linux 看进程：`cat .proxy-inspector.pid` 再 `ps -p $(cat .proxy-inspector.pid)`。
- 看日志：Linux `logs/proxy-*.log`，Windows `logs\proxy.log`。
