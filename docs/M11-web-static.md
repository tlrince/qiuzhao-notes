# M11 Web 静态部署

Web 端使用 `BrowserRouter`，因此生产静态站点需要把不存在的页面路径回退到 `index.html`。Nginx 样例位于 [`deploy/nginx/autumn-notes.conf`](../deploy/nginx/autumn-notes.conf)：Vite 带内容哈希的 `/assets/` 文件可缓存一年；HTML 入口不缓存；缺失的 `/assets/` 文件和其他带扩展名的静态文件返回 404，不回退成 HTML。

## 构建和放置文件

在项目根目录执行：

```sh
npm run build
```

将 `web-dist/` **目录内容**复制到 Nginx `root` 指向的目录（样例默认为 `/var/www/autumn-notes`）：

```sh
sudo mkdir -p /var/www/autumn-notes
sudo cp -a web-dist/. /var/www/autumn-notes/
```

部署环境负责配置 Nginx 的 `listen`、域名 `server_name`、HTTPS 证书及 TLS；样例只定义静态文件、路由回退和缓存行为。当前前端以站点根路径 `/` 构建，样例适用于域名根路径托管。

## 本地验证

运行 `npm run test:m11:static`。若机器安装了 Nginx，还可以把样例纳入 `http {}` 配置并运行 `nginx -t`。本项目开发容器未安装 Nginx，因此 Node 测试会检查配置规则，并以当前 `web-dist/` 验证首页、BrowserRouter 深链、哈希资源及缺失静态资源的路由/缓存契约；它不代替实际 Nginx 解析器验证。
