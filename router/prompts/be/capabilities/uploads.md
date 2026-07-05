## File Uploads

Use `multer` for file handling. Storage logic belongs in the service layer.

Rules:
- Configure multer in `src/middleware/upload.middleware.ts`
- Validate file types and sizes in the multer config (not in routes)
- File processing belongs in the service (renaming, moving, cloud upload)
- Never store files in routes or controllers

Pattern:
```typescript
// src/middleware/upload.middleware.ts
import multer from 'multer';
import path from 'path';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname)}`),
});

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('File type not allowed'));
};

export const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });
```

Route usage: `router.post('/upload', upload.single('file'), controller.upload);`
