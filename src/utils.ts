export function stripContextTags(text: string): string {
  return text
    .replace(
      /<(?:system_reminder|user_info|git_status|open_and_recently_viewed_files|rules|agent_skills|agent_transcripts|attached_files|external_links|image_files|terminal_files_information|ide_opened_file|ide_selection)[^>]*>[\s\S]*?<\/[^>]+>/g,
      ''
    )
    .replace(/<\/?user_query>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
