export interface AvatarEntry {
  id: string;
  name: string;
  src: string;
  category: 'mentor' | 'friend' | 'therapist' | 'coach';
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
  // Therapist avatars
  { id: 'therapist-male-01', name: 'James', src: '/avatars/therapist-male-01.svg', category: 'therapist' },
  { id: 'therapist-female-01', name: 'Sarah', src: '/avatars/therapist-female-01.svg', category: 'therapist' },
  // Coach avatars
  { id: 'coach-male-01', name: 'Alex', src: '/avatars/coach-male-01.svg', category: 'coach' },
  { id: 'coach-female-01', name: 'Jordan', src: '/avatars/coach-female-01.svg', category: 'coach' },
];

export function getAvatarById(id: string): AvatarEntry | undefined {
  return avatarManifest.find((a) => a.id === id);
}

export function getAvatarsByCategory(category: string): AvatarEntry[] {
  return avatarManifest.filter((a) => a.category === category);
}