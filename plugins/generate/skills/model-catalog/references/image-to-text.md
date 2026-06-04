# Image-to-Text Endpoints

Curated picks for OCR, captioning/VQA, and detection/segmentation. **Moondream 3** is the dominant pick across all three; **Florence-2** and **SAM-3** complete the toolset. Verify with `vg generate models --endpoint_id <id> --json` before running.

## OCR, extract text from image

- `got-ocr/v2`: GOT OCR 2.0
- `florence-2-large/ocr`: Florence-2 Large (OCR head)
- `moondream3-preview/segment`: Moondream 3 Preview (segment also reads text regions)
- `moondream3-preview/query`: Moondream 3 Preview (query for text content)

## Caption / VQA

Image description and visual question-answering.

- `moondream3-preview/caption`: Moondream 3 · Caption
- `moondream3-preview/query`: Moondream 3 · Query (VQA)
- `florence-2-large/caption`: Florence-2 Large
- `florence-2-large/detailed-caption`: Florence-2 Large · Detailed
- `florence-2-large/more-detailed-caption`: Florence-2 Large · More Detailed
- `video-understanding`: Video Understanding
- `auto-caption`: Auto-Captioner
- `perceptron/isaac-01`: Perceptron · Isaac 0.1
- `perceptron/isaac-01/openai/v1/chat/completions`: Perceptron · Isaac 0.1 (OpenAI-compatible)

## Detection / Segmentation

Nesne tespit ve maskeleme.

- `moondream3-preview/detect`: Moondream 3 · Detect (open-vocabulary detection)
- `moondream3-preview/point`: Moondream 3 · Point
- `moondream2/object-detection`: Moondream 2 · Object Detection
- `moondream2/point-object-detection`: Moondream 2 · Point Object Detection
- `sam-3/image/embed`: SAM 3 · Image Embed (segmentation backbone)
- `florence-2-large/region-to-category`: Florence-2 · Region-to-Category
- `florence-2-large/region-to-description`: Florence-2 · Region-to-Description
- `perceptron/isaac-01`: Perceptron · Isaac 0.1
- `perceptron/isaac-01/openai/v1/chat/completions`: Perceptron · Isaac 0.1 (OpenAI-compatible)

## Common parameters

```bash
vg generate schema moondream3-preview/query --json
vg generate schema got-ocr/v2 --json
vg generate schema sam-3/image/embed --json
```

Frequently exposed:

- `image_url`: source image
- `prompt` / `query` / `question`, for VQA or guided segmentation
- `threshold`: confidence cutoff (detection)
- `output_format`: for masks: `png` alpha, `binary`, `coco-rle`, etc.

## Discovery

```bash
vg generate models --category vision --limit 10 --json
vg generate models "ocr" --json
vg generate models "image segmentation" --json
vg generate docs "vision" --json
```

## See also

- For mask manipulation utilities, search the catalog with `vg generate models --category <modality>`
- For document scan cleanup before OCR, see [media-recipes/references/image-restoration.md](../../media-recipes/references/image-restoration.md)
