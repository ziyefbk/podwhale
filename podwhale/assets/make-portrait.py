from PIL import Image, ImageDraw
from pathlib import Path

HERE = Path(__file__).resolve().parent

src = HERE / 'sheet.png'
im = Image.open(src).convert('RGBA')
w, h = im.size

# Remove the white sheet background: flood fill from the four corners only, so
# the white outfit (enclosed by line art) survives.
for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
    ImageDraw.floodfill(im, corner, (0, 0, 0, 0), thresh=26)

alpha = im.split()[3]
front = alpha.crop((0, 0, w // 3, h))
box = front.getbbox()
print('front bbox:', box)

x0, y0, x1, y1 = box
figure = im.crop((x0, y0, x1, y1))
print('figure:', figure.size)

# Portrait = the top part of the figure, squashed into a square.
head_h = int(figure.size[1] * 0.42)
head = figure.crop((0, 0, figure.size[0], head_h))
side = max(head.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(head, ((side - head.size[0]) // 2, 0), head)

out = square.resize((320, 320), Image.LANCZOS)
out.save(HERE / 'whale-girl.png')
print('saved:', out.size, out.mode)
