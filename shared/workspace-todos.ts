import { z } from 'zod';

const dueDate = z.string().refine(value => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value, '请填写有效的截止日期');
export const workspaceTodoInputSchema = z.object({
  id: z.string().uuid().optional(), title: z.string().trim().min(1, '请填写待办事项').max(200),
  details: z.string().trim().max(2000).default(''), dueDate: dueDate.default(''),
  priority: z.enum(['normal', 'high']).default('normal'), status: z.enum(['todo', 'doing', 'done']).default('todo'),
}).strict();
export const workspaceTodoRemoveSchema = z.object({ id: z.string().uuid() }).strict();
export const workspaceTodoSchema = workspaceTodoInputSchema.extend({ id: z.string().uuid(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type WorkspaceTodoInput = z.input<typeof workspaceTodoInputSchema>;
export type TodoItem = z.infer<typeof workspaceTodoSchema>;
export const workspaceTodoStatusLabels = { todo: '待办', doing: '进行中', done: '已完成' } as const;
