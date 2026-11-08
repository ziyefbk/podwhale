# 鲸鱼娘公开素材 v1

本目录五张 PNG 使用内置 imagegen 工具在 2026-11-08 生成，供 Podwhale 插件直接加载。PNG 从工具输出逐字节复制，没有裁切、去背、缩放或重新编码；透明背景由生成工具提供。所有素材在公开安装包中默认提供。

## 来源与范围

- atlas-a.png 仅以仓库公开宣传插画 `.github/marketing/whale-community-art.png` 作为角色和画风参考。
- atlas-b.png、atlas-c.png、portrait.png、face.png 以本轮新生成的 atlas-a.png 作为一致性参考。
- 本轮工具输入没有使用旧的本机 `assets/*.png`。这些旧第三方可选素材仍不进入仓库或公开包。
- 新生成图片不作为原始第三方素材的授权证明；来源记录不会变更原图的权利或把旧素材重新声明为 MIT。软件许可范围见包内 NOTICE。
- 三张图集各为 4 列 × 4 行、每行四帧，共 12 个动作、48 个格子。实际 PNG 宽高和 SHA256 见 manifest.json，允许单格为小数尺寸。
- 动作是本地展示，不会授予 AI 读帖、发帖、发送消息或审批的权限。说话动作不代表语音播放。

## 动作布局

| 图集 | 从上到下每行的动作 |
|---|---|
| atlas-a.png | idle 待机眨眼、wave 挥手、happy 开心、sleep 睡觉 |
| atlas-b.png | think 思考、drag 被拖动、read 读书、write 写字 |
| atlas-c.png | talk 说话、walk 走路、stretch 伸懒腰、surprised 惊讶 |

## 原始生成提示词

生成模式：内置 imagegen；每个条目一次单独调用；全部设置 transparent_background=true。输出按以下对应关系保存，不用提示词推断尺寸，始终以 PNG 实际尺寸为准。

### atlas-a.png

Reference: `.github/marketing/whale-community-art.png`

```text
Use case: stylized-concept. Production asset: transparent PNG animation sprite atlas for the existing Podwhale desktop pet. Reference image is identity/style reference only: preserve exactly this blue-haired anime chibi whale maid, long wavy deep cobalt/periwinkle hair, blue eyes, white frilled maid headband, navy fin-like side ears with blue bows, navy and white maid dress, white apron with small blue whale emblem, white socks and navy Mary Jane shoes, large blue whale tail behind her right side. Do not redesign her or turn her into a round fish, 3D toy, pixel character or simple vector. Match the reference's polished 2D anime cel shading and adorable proportions.
Create ONE SQUARE 2048x2048 sprite sheet, a mathematically regular 4 columns x 4 rows grid, all 16 equal square cells. Genuine transparent background, no visible checkerboard, no borders/grid lines, no words/captions/numbers, no extra characters, no floor or scene. Each cell contains the same complete full-body character; keep identical head/body scale and anchor registration between neighboring frames. All hair/tail/hands/shoes fit inside their cell with at least 7% transparent margin. Never let a pose cross a cell boundary. Standing poses occupy approximately 82% of cell height, feet share a stable baseline. Four consecutive frames read left to right; movement is restrained and loopable.
ROW 1 IDLE BLINK: same neutral friendly standing pose, frame1 eyes open, frame2 half closed, frame3 eyes closed, frame4 open again with tiny breath/hair sway.
ROW 2 WAVE: friendly standing, right hand lifted, 4 consecutive small wave positions, happy open eyes; body and feet stable.
ROW 3 HAPPY: hands near chest then lifted in delight, closed smiling eyes at peak, subtle bounce and tail wag, 4 consecutive loop frames, no floating hearts/stars outside character.
ROW 4 SLEEP: seated resting pose, eyes gradually closed, hands on lap, tiny breathing motion, head gently nods; 4 stable loop frames. Keep same character appearance, no pillow/props/text.
This is actual in-app animation material, not a poster or concept board. Accurate 4x4 cell layout and transparent margins are critical.
```

### atlas-b.png

Reference: `pet-art/atlas-a.png`

```text
Use case: stylized-concept. Asset: real transparent animation atlas for the Podwhale desktop pet. Image 1 is the identity and sprite-layout reference. Preserve the exact SAME blue-haired anime chibi whale maid from this reference: long wavy cobalt and periwinkle hair, blue eyes, white maid headband, navy fin-shaped side ears and blue bows, navy/white maid outfit, whale-emblem apron, white socks, navy shoes, large blue whale tail. Same proportions, linework and 2D anime cel shading; no redesign, no 3D, no pixel/vector simplification. Make a square 4-column x 4-row PNG sprite sheet, 16 equal square cells. Genuine transparent background with clean alpha, no checkerboard, no text, captions, numbers, borders, props outside cells, scene or extra characters. Keep complete body/hair/hands/tail in every cell, even grid alignment and matching scale, stable baseline between the 4 frames of each row. Leave clear transparent gutter around all silhouettes; aim 8% margins. Four consecutive loop frames left to right per row. New poses only, do not repeat the reference's existing blink/wave/happy/sleep rows. No cell-boundary crossings.
ROW 1 THINK: hand to chin, thoughtful gaze then slightly tilted head, closed thoughtful eyes briefly then return, four subtle frames.
ROW 2 DRAG: being gently picked up, arms a little out, shoes dangling, surprised but friendly face; tiny left/right pendulum sway, four frames. She is alone, no grabbing hand or cursor.
ROW 3 READ: holding an open blue book at chest, eyes down and track the page, small page turn across four frames. Keep face visible and book entirely in cell.
ROW 4 WRITE: holding a small notebook and pen, four sequential small writing hand movements, concentrating expression, face visible. Notebook has no readable lettering.
Each row must use all FOUR cells, and rows must be separate. A production 4x4 sprite atlas, not a poster.
```

### atlas-c.png

Reference: `pet-art/atlas-a.png`

```text
Use case: stylized-concept. Asset: real transparent animation atlas for the Podwhale desktop pet. Image 1 is the identity and sprite-layout reference. Preserve the exact SAME blue-haired anime chibi whale maid from this reference: long wavy cobalt and periwinkle hair, blue eyes, white maid headband, navy fin-shaped side ears and blue bows, navy/white maid outfit, whale-emblem apron, white socks, navy shoes, large blue whale tail. Same proportions, linework and 2D anime cel shading; no redesign, no 3D, no pixel/vector simplification. Make a square 4-column x 4-row PNG sprite sheet, 16 equal square cells. Genuine transparent background with clean alpha, no checkerboard, no text, captions, numbers, borders, props outside cells, scene or extra characters. Keep complete body/hair/hands/tail in every cell, even grid alignment and matching scale, stable baseline between the 4 frames of each row. Leave clear transparent gutter around all silhouettes; aim 8% margins. Four consecutive loop frames left to right per row. New poses only, do not repeat the reference's existing blink/wave/happy/sleep rows. No cell-boundary crossings.
ROW 1 TALK: friendly conversational gesture, four different mouth shapes (closed, slightly open, open smile, closed) and small hand motions. No speech balloons or text.
ROW 2 WALK: complete 4-frame in-place walking loop, slight three-quarter orientation, alternating feet and arms, gentle tail/hair follow-through; same position in each cell, no horizontal translation across sheet.
ROW 3 STRETCH: starts hands near shoulders, lifts both hands in a gentle overhead stretch, holds stretch eyes closed contentedly, lowers hands; full hair/head/hands remain within cells with generous top margins.
ROW 4 SURPRISED: attentive face, eyes widen and mouth round, hands lift near cheeks, relaxes toward baseline. No exclamation marks, hearts, stars or decorative particles.
Each row must use all FOUR cells, and rows must be separate. A production 4x4 sprite atlas, not a poster.
```

### portrait.png

Reference: `pet-art/atlas-a.png`

```text
Use case: identity-preserve. The provided sprite atlas is the EXACT character reference for the Podwhale whale maid. Preserve the identical blue-haired anime chibi girl: long wavy cobalt/periwinkle hair, large blue eyes, white frilled maid headband, navy fin-like ears and small blue bows, navy and white maid outfit and whale emblem, same 2D anime cel shading/proportions/colors. Do not redesign. Transparent PNG with true clean alpha, no checkerboard, solid backdrop, ground shadow, text, logo, watermark, grid, collage, or extra figures. Draw only ONE character. Create one square full-body standing portrait in the neutral friendly pose from row1 column1 of the reference. Full shoes, entire hair, top hair curl and blue whale tail must be in frame, centered with about 9% transparent padding on all edges. Eyes open, gentle welcoming smile, arms resting slightly away from body. Intended as the in-app static pet fallback, retain crisp small-display readability.
```

### face.png

Reference: `pet-art/atlas-a.png`

```text
Use case: identity-preserve. The provided sprite atlas is the EXACT character reference for the Podwhale whale maid. Preserve the identical blue-haired anime chibi girl: long wavy cobalt/periwinkle hair, large blue eyes, white frilled maid headband, navy fin-like ears and small blue bows, navy and white maid outfit and whale emblem, same 2D anime cel shading/proportions/colors. Do not redesign. Transparent PNG with true clean alpha, no checkerboard, solid backdrop, ground shadow, text, logo, watermark, grid, collage, or extra figures. Draw only ONE character. Create one square close-up AVATAR portrait of the same character, head and upper shoulders only, facing forward, blue eyes open with a gentle closed-mouth smile. The headband, fin-shaped ears, bows and top hair curl should all fit within the square with 7% clear alpha margins. Face fills about two thirds of the image, clean bold silhouette and big recognizable blue eyes for a 22px avatar. No hands, no full body, no speech bubble. Keep exactly the same face and hair identity as the reference.
```
