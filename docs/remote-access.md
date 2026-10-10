# 远程访问

主服务默认只监听 `127.0.0.1`，保留本机 Host、Origin 和写操作确认检查。源码包含 `server/lan-gateway-main.ts`、`server/vpn-gateway-main.ts`、`server/remote-bridge-main.ts` 及 `tools/remote-access/` 网关工具；网络地址、证书和凭据由使用者配置。

LAN/VPN 应绑定自己的私有地址，并限制允许的客户端。独立 HTTPS 网关负责登录和会话，再经受限 SSH 隧道转发到本机桥接入口。SSE 继续流式传输，不用缓冲压缩替代实时事件。

首次生成自己网关的独立登录配置，先设置 `DELIVERY_REMOTE_ORIGIN`（自己的 HTTPS origin）与 `DELIVERY_REMOTE_USERNAME`，再执行：

```sh
node tools/remote-access/create-credentials.mjs
```

凭据默认生成到当前用户 `~/.config/delivery-remote`，目录权限 `0700`、文件权限 `0600`，不输出密码。可用 `DELIVERY_REMOTE_CONFIG_DIR` 指定自己的目录。`DELIVERY_REMOTE_UPSTREAM_PORT`、`DELIVERY_REMOTE_UPSTREAM_HOST`、`DELIVERY_REMOTE_CERT` 和 `DELIVERY_REMOTE_KEY` 控制本机上游、证书和密钥。

部署模板在 `tools/remote-access/`。替换为自己的主机、服务用户、证书和隧道配置，先验证登录、未登录拒绝、同源检查、SSE 和远端读取，再用于工作。运行 `node --test tools/remote-access/gateway.test.mjs` 可检查网关协议保护；本仓库没有为接收方部署外网服务。
