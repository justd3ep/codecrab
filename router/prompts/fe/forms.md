Forms Guidelines:
- Default to native React useState with controlled inputs for self-contained components.
- Only use react-hook-form or zod if explicitly requested in the prompt or present in package.json.
- Type all form values with a TypeScript interface.
- Always handle loading, error, and success states cleanly with React state.
- Validate inputs using clean TypeScript helper functions or HTML5 constraint attributes.
- Display field-level error messages below invalid inputs.
- Disable submit button while submission is in progress.

Pattern (Native React):
interface FormValues {
  email: string;
  amount: number;
  category: string;
}
const [formData, setFormData] = React.useState<FormValues>({ email: '', amount: 0, category: '' });
const [errors, setErrors] = React.useState<Record<string, string>>({});
const [isSubmitting, setIsSubmitting] = React.useState(false);

Never:
- Import react-hook-form, zod, formik, or other form packages unless verified in package.json.
- Use uncontrolled inputs without proper state tracking.
- Submit without basic field validation.
