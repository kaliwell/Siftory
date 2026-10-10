import type { Tab, PromptTab } from '../types'

export function createDefaultTabs(): Tab[] {
  const home = '~'
  return [
    {
      name: '工作',
      shortcuts: [
        { name: '文档', path: `${home}/Documents` },
        { name: '下载', path: `${home}/Downloads` },
        { name: '用户文件夹', path: home },
      ],
    },
    { name: '学习', shortcuts: [] },
    { name: '游戏', shortcuts: [] },
  ]
}

export function createDefaultPromptTabs(): PromptTab[] {
  return [
    {
      name: '编程',
      prompts: [
        {
          name: '代码审查',
          text: '请审查以下代码，重点关注：\n1. 潜在的bug和安全漏洞\n2. 性能优化机会\n3. 代码可读性和维护性\n\n代码：\n```\n\n```',
        },
        {
          name: 'SQL 优化',
          text: '请优化以下SQL查询，重点考虑：\n1. 索引使用\n2. 查询计划\n3. 避免全表扫描\n4. JOIN顺序优化\n\nSQL：\n\n',
        },
      ],
    },
    {
      name: '生图',
      prompts: [
        {
          name: '写实风格',
          text: '请生成一张写实风格的图片，要求：\n- 高细节、高分辨率\n- 自然光影\n- 构图平衡\n\n描述：',
        },
      ],
    },
    {
      name: '角色扮演',
      prompts: [
        {
          name: '面试官',
          text: '请你扮演一位资深技术面试官，对我进行一场模拟面试。\n- 职位：\n- 技术栈：\n- 难度等级：\n',
        },
      ],
    },
  ]
}
