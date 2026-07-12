import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const skillsDir = path.join(process.cwd(), "skills");

type Skill = {
  name: string;
  description: string;
  body: string;
  folder: string;
};

// Each skill is a subfolder containing a SKILL.md file (Agent Skills spec)
export const skills: Skill[] = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) return [];
    const { data, content } = matter.read(skillFile);
    return [{
      name: (data.name as string | undefined) ?? "Untitled",
      description: (data.description as string | undefined) ?? "",
      body: content.trim(),
      folder: entry.name,
    }];
  });

const skillManifest = skills
  .map((s) => `- **${s.name}**: ${s.description}`)
  .join("\n");

export function buildSystemPrompt(): string {
  return `You are a helpful AI assistant. Execute tools silently without narrating them.

You have access to the following skills. Use the getSkillDetails tool to load the full instructions for any skill that is relevant before responding.

## Available Skills
${skillManifest}`;
}

export function getSkillByName(name: string): Skill | undefined {
  return skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
}