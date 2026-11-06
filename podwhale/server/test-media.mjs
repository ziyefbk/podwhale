/**
 * 图片进门检查的测试：造几个带元数据的假文件，看剥离是否只丢元数据。
 *
 *   node server/test-media.mjs
 */
import { sniff, stripMetadata, extensionOf } from './media.mjs';
let failed = 0;
function check(name, ok, detail = "") {
    if (ok)
        console.log('ok  ', name);
    else {
        failed += 1;
        console.log('FAIL', name, detail === undefined ? '' : '-> ' + detail);
    }
}
// ---- PNG: 造一张 1x1，夹一个 tEXt（作者/软件）和一个 iTXt
function pngChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); // CRC 随便写，我们的剥离器不校验
    return Buffer.concat([head, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Author\0somebody', 'latin1')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>', 'latin1')),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
]);
check('a PNG is recognised by its header', sniff(png) === 'png', sniff(png));
const pngStripped = stripMetadata(png, 'png');
check('PNG text metadata is gone', pngStripped.toString('latin1').indexOf('somebody') < 0 && pngStripped.toString('latin1').indexOf('xmpmeta') < 0);
check('PNG pixels survive', pngStripped.toString('latin1').indexOf('IDAT') > 0 && pngStripped.subarray(0, 8).equals(png.subarray(0, 8)));
check('PNG keeps its chunks ordered', pngStripped.indexOf('IHDR') < pngStripped.indexOf('IDAT'));
// ---- JPEG: SOI + APP1(EXIF) + APP0(JFIF) + COM + SOS
function jpegSegment(marker, payload) {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
}
const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, Buffer.from('Exif\0\0GPS 31.23,121.47 OFFICE-CAMERA-9921', 'latin1')),
    jpegSegment(0xe0, Buffer.concat([Buffer.from('JFIF', 'latin1'), Buffer.from([0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])])),
    jpegSegment(0xfe, Buffer.from('shot by someone at home', 'latin1')),
    jpegSegment(0xda, Buffer.from([0x01, 0x02, 0x03])),
    Buffer.from([0xff, 0xd9]),
]);
check('a JPEG is recognised by its header', sniff(jpeg) === 'jpeg', sniff(jpeg));
const jpegStripped = stripMetadata(jpeg, 'jpeg');
check('JPEG EXIF is gone', jpegStripped.toString('latin1').indexOf('OFFICE-CAMERA') < 0 && jpegStripped.toString('latin1').indexOf('31.23') < 0);
check('JPEG comments are gone', jpegStripped.toString('latin1').indexOf('shot by someone') < 0);
check('JPEG keeps JFIF', jpegStripped.toString('latin1').indexOf('JFIF') > 0);
check('JPEG image data survives', jpegStripped.toString('latin1').indexOf('\xff\xda') > 0 && jpegStripped[jpegStripped.length - 2] === 0xff);
// ---- WebP: RIFF + VP8X + EXIF chunk
function webpChunk(type, data) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([head, data, pad]);
}
const webpBody = Buffer.concat([
    webpChunk('EXIF', Buffer.from('camera serial 7781', 'latin1')),
    webpChunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00])),
]);
const webpHeader = Buffer.alloc(12);
webpHeader.write('RIFF', 0, 'ascii');
webpHeader.writeUInt32LE(webpBody.length + 4, 4);
webpHeader.write('WEBP', 8, 'ascii');
const webp = Buffer.concat([webpHeader, webpBody]);
check('a WebP is recognised by its header', sniff(webp) === 'webp', sniff(webp));
const webpStripped = stripMetadata(webp, 'webp');
check('WebP EXIF is gone', webpStripped.toString('latin1').indexOf('camera serial') < 0);
check('WebP pixels survive', webpStripped.toString('latin1').indexOf('VP8L') > 0);
// ---- 拒绝非图片
check('a text file is not an image', sniff(Buffer.from('<html>hello</html>')) === null);
check('an empty buffer is not an image', sniff(Buffer.alloc(0)) === null);
check('a GIF is not accepted', sniff(Buffer.from('GIF89a............', 'latin1')) === null);
check('extensions follow the real type', extensionOf('jpeg') === 'jpg' && extensionOf('png') === 'png' && extensionOf('webp') === 'webp');
// 幂等：剥过的再剥一次不变
check('stripping is idempotent', stripMetadata(pngStripped, 'png').equals(pngStripped));
console.log('');
if (failed === 0) {
    console.log('ALL PASS');
    process.exit(0);
}
console.log(failed + ' FAILED');
process.exit(1);
