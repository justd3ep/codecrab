Forms Guidelines:
- Use react-hook-form for form state management.
- Use zod for schema validation with zodResolver.
- Type form values with an interface or zod infer.
- Always handle loading, error, and success states.
- Use Controller for controlled inputs.
- Display field-level errors from formState.errors.
- Disable submit button while isSubmitting.

Example pattern:
const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
type FormValues = z.infer<typeof schema>;
const { register, handleSubmit, formState } = useForm<FormValues>({ resolver: zodResolver(schema) });

Never:
- Use uncontrolled inputs without register().
- Validate manually with if-else chains.
- Ignore formState.errors.
