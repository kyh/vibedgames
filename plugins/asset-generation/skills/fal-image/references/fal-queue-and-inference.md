# fal Queue And Inference Notes

This skill uses queue mode even for images so image experiments are logged the same way as video experiments.

## Submission Shape

Basic submit:

```bash
curl -X POST "https://queue.fal.run/fal-ai/nano-banana-2" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a futuristic cityscape at sunset"}'
```

The queue response includes:

- `request_id`
- `status_url`
- `response_url`

Those returned URLs should be treated as authoritative.

## Image Inputs

For edit endpoints, fal accepts file URLs and also Base64 data URIs. In this repo we default to data URIs for local files so the first workflow does not depend on a separate upload step.

## Output Handling

Most image endpoints return:

- `images`: list of generated image objects

Each image object typically contains:

- `url`
- `file_name`
- `content_type`
- sometimes width and height

The repo runner walks the whole payload instead of hard-coding one output path so it can survive small schema differences.

## Failure Handling

Do not swallow API errors.

Even on failure, write:

- create JSON
- latest status JSON when available
- normalized run manifest

That keeps failed experiments auditable.

