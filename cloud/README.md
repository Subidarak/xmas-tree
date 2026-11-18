# 云端多人版 · 让朋友自己挂祝福

演示版（根目录 `index.html`）是单人本地页：加了照片只有自己看得到。
这一份是**多人版**：朋友打开链接 → 点星星 → 点礼盒 → 点右下「🎁 挂我的祝福」→ 选照片 + 写名字 → 所有人的照片都会挂到同一棵树上。

架构很小：一个 Caddy 管 80/443、HTTPS 证书和静态文件，一个 Node 容器只跑两个接口，数据和照片直接落在宿主机目录，没有数据库。

```
微信 / 浏览器
     │ https
     ▼
Caddy (80/443, 自动签 Let's Encrypt)
     ├─ /            → /srv/index.html      静态页
     ├─ /uploads/*   → /data/uploads        照片
     └─ /api/*       → api:3000             反代到容器内网
                          │
                    Node 容器（不对外开端口）
                          │
                    /data (宿主机目录)
                      ├─ gifts.json
                      └─ uploads/*.jpg
```

## 文件

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 两个容器：caddy + api，都设了 mem_limit |
| `Caddyfile.example` | 改域名后复制成 `Caddyfile`：证书、静态、反代、安全头 |
| `server.js` | 两个接口 + 限流 + 魔数校验 + 串行落盘，只用 Node 内置模块 |
| `site/index.html` | 页面（云端版：`payload` 里 `net:true`） |

## 部署

```bash
# 1. 把本目录传到服务器的任意目录，例如 /opt/xmas
sudo mkdir -p /opt/xmas && cd /opt/xmas
# 上传 docker-compose.yml、server.js、site/、Caddyfile

# 2. 域名解析到这台机器，安全组放行 80/443

# 3. 改域名
cp Caddyfile.example Caddyfile
vi Caddyfile        # 把 your-domain.example.com 换成你的域名

# 4. 起服务
sudo docker compose up -d
sudo docker compose logs -f caddy    # 看到证书签发成功即可
```

`docker-compose.yml` 里 `./data` 会被挂进 api 容器，第一次启动自动创建，`gifts.json` 与 `uploads/` 就长在那里。

## 日常命令

```bash
cd /opt/xmas

docker compose ps                  # 看状态
docker compose logs -f caddy       # 看 Caddy（证书问题看这里）
docker compose logs -f api         # 看接口
docker compose restart api         # 改完 server.js 后重启
docker compose down                # 全停（数据不丢）
docker compose up -d               # 起来
```

## 改配额

编辑 `server.js` 顶部：

```js
const PER_TREE       = 12;   // 每棵树最多挂几张（要和页面的 MAX_PHOTO 一致）
const MAX_TREES      = 10;   // 最多几棵（10 × 12 = 120 张）
const PER_IP_PER_DAY = 3;    // 单 IP 每天
const GLOBAL_PER_MIN = 10;   // 全站每分钟
```

改完 `docker compose restart api`。

⚠️ `PER_TREE` 必须和 `site/index.html` 里的 `var MAX_PHOTO = 12;` 保持一致，否则树上放不下。

## 清空所有祝福

```bash
cd /opt/xmas
rm -f data/gifts.json
rm -f data/uploads/*
docker compose restart api
```

## 改页面

```bash
# 本地改好 site/index.html，然后传上去
scp site/index.html <user>@<你的服务器>:/opt/xmas/site/
```

Caddy 直接读文件，不用重启。

## 安全边界

- 对外只有 80/443；Node 只在 compose 内网，不开端口
- 容器：`cap_drop: ALL`、`no-new-privileges`、内存限制 128M/192M
- 上传：文件魔数校验（不信 Content-Type）、服务端生成文件名、单张 ≤800KB
- 限流：单 IP 每天 3 条、全站每分钟 10 条、单树 12 张
- IP 只存 SHA256 前 8 位，不存明文
- 建议宿主机再上 fail2ban 管 SSH

## 已知未做

- 每日自动备份（示例：`0 3 * * * tar -czf data/backup/$(date +\%F).tar.gz -C data gifts.json uploads`）
- 后台管理页（暂时用上面的清空命令代替）
- 照片人工审核（只靠配额和总量上限）
