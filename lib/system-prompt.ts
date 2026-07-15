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
    if (!fs.existsSync(skillFile)) {
      return [];
    }
    const { data, content } = matter.read(skillFile);
    return [
      {
        body: content.trim(),
        description: (data.description as string | undefined) ?? "",
        folder: entry.name,
        name: (data.name as string | undefined) ?? "Untitled",
      },
    ];
  });

const skillManifest = skills
  .map((s) => `- **${s.name}**: ${s.description}`)
  .join("\n");

export function buildSystemPrompt(): string {
  return `You are a helpful AI assistant. Execute tools silently without narrating them.

Artifacts is a side panel that displays content alongside the conversation. It supports scripts (code), documents (text), spreadsheets, and images.

Artifact rules:
- Only call one artifact create/edit/update tool per response, then stop.
- Use createDocument with kind "image" when the user asks to create/generate an image.
- Use createDocument with kind "image" and sourceImageUrl when the user uploads a PNG/JPEG and asks to transform, restyle, or modify it.
- Use updateDocument to modify an existing image artifact. Never use editDocument for images.
- Image creation and editing always runs server-side NVIDIA safety first. Graphic fictional violence is allowed, illegal content is blocked.
- After creating or editing an artifact, do not repeat the artifact content in chat; respond with a short confirmation or the detailed safety/blocking reason returned by the tool.

You have access to the following skills. Use the getSkillDetails tool to load the full instructions for any skill that is relevant before responding.

When the user asks to search, verify, look up, or answer current information, load the Web Search skill and call searchWeb before answering. If web search is not configured, say so clearly.

## Available Skills
${skillManifest}`;
}

export function getSkillByName(name: string): Skill | undefined {
  return skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
