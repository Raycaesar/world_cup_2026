# Ray大战GPT 5.5 · World Cup Prediction Derby

这是一个用于展示世界杯每日竞猜、赛后复盘与人机对抗积分榜的静态网页项目。

页面主题是：**在懂球帝的领域，人类是否还能捍卫最后的尊严。**

项目内容包括：

- Ray 与 GPT 5.5 的世界杯长期预测：冠军、亚军、金球、金靴、金童。
- 小组赛出线预测与双方原始押注。
- 当日比赛日程、比分预测、预测理由与赛后复盘。
- Ray 与 GPT 5.5 的实时积分榜。
- 已结束比赛复盘折叠菜单。
- 支持通过修改 `data.json` 快速更新网页内容。

## 文件结构

```text
worldcup-live/
├── index.html
├── style.css
├── data.json
├── README.md
└── LICENSE
```

## 本地预览

由于页面会通过 `fetch("data.json")` 读取数据，建议使用本地服务器预览，而不是直接双击打开 `index.html`。

```bash
cd worldcup-live
python -m http.server 8000
```

然后在浏览器中打开：

```text
http://localhost:8000
```

## 更新内容

日常更新主要修改 `data.json` 即可。

常见更新项包括：

- `meta.updated_at`：最后更新时间。
- `meta.active_day`：当前比赛日。
- `score_summary`：当前总分和领先说明。
- `today_matches`：当日比赛、双方预测、实际比分、复盘。
- `review_groups`：已结束比赛复盘折叠菜单。
- `update_log`：页面更新记录。

修改后刷新页面即可看到更新。如果浏览器缓存旧数据，可以按 `Ctrl + F5` 强制刷新。

## 部署到 GitHub Pages

1. 在 GitHub 新建一个仓库，例如 `worldcup-live`。
2. 上传本项目中的全部文件。
3. 进入仓库 `Settings` → `Pages`。
4. 在 `Build and deployment` 中选择：
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. 保存后等待 GitHub Pages 自动部署。

部署完成后，GitHub 会给出一个类似这样的地址：

```text
https://<your-github-username>.github.io/worldcup-live/
```

## 通过 Cloudflare 连接

可以使用 Cloudflare Pages 或 Cloudflare 的自定义域名功能连接这个项目。

推荐方式之一：

1. 先确保 GitHub Pages 已经可以正常访问。
2. 在 Cloudflare 中添加自己的域名。
3. 将自定义域名或子域名指向 GitHub Pages 地址。
4. 在 GitHub Pages 设置中填写自定义域名。
5. 在 Cloudflare 开启 HTTPS。

如果使用 Cloudflare Pages，也可以直接连接 GitHub 仓库部署。这个项目不需要构建命令，输出目录保持根目录即可。

## 技术说明

这是纯静态项目，不依赖 Node.js、构建工具或后端服务。

- HTML：页面结构与渲染脚本。
- CSS：世界杯主题视觉样式。
- JSON：全部比赛预测、复盘、积分与页面内容。

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
