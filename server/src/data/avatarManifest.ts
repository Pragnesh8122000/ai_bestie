export interface AvatarEntry {
  id: string;
  name: string;
  src: string;
  category: 'mentor' | 'friend';
}

export const avatarManifest: AvatarEntry[] = [
  // Mentor avatars
  { id: 'mentor-male-01', name: 'Marcus', src: '/avatars/mentor-male-01.svg', category: 'mentor' },
  { id: 'mentor-male-02', name: 'David', src: '/avatars/mentor-male-02.svg', category: 'mentor' },
  { id: 'mentor-female-01', name: 'Elena', src: '/avatars/mentor-female-01.svg', category: 'mentor' },
  { id: 'mentor-female-02', name: 'Priya', src: '/avatars/mentor-female-02.svg', category: 'mentor' },
  // Friend avatars
  { id: 'friend-male-01', name: 'Jake', src: '/avatars/friend-male-01.svg', category: 'friend' },
  { id: 'friend-male-02', name: 'Sam', src: '/avatars/friend-male-02.svg', category: 'friend' },
  { id: 'friend-female-01', name: 'Mia', src: '/avatars/friend-female-01.svg', category: 'friend' },
  { id: 'friend-female-02', name: 'Luna', src: '/avatars/friend-female-02.svg', category: 'friend' },
];

export function getAvatarById(id: string): AvatarEntry | undefined {
  return avatarManifest.find((a) => a.id === id);
}

export function getAvatarsByCategory(category: string): AvatarEntry[] {
  return avatarManifest.filter((a) => a.category === category);
}