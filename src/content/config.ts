import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    heroImage: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});



export const collections = { blog };

