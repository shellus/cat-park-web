import * as Dialog from '@radix-ui/react-dialog';
import { X, Cat, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { CharacterOption, PlayerProfile } from '../../shared/protocol';

export function IconButton({
  icon: Icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} {...props}>
      <Icon size={19} strokeWidth={1.8} />
    </button>
  );
}
export function Avatar({
  player,
  characters,
  size = 'small',
}: {
  player: PlayerProfile;
  characters: CharacterOption[];
  size?: 'small' | 'large';
}) {
  const character = characters.find(option => option.id === player.characterId);
  return (
    <span className={`avatar avatar-${size}`} style={{ backgroundColor: player.color }}>
      {character ? <img src={character.preview} alt="" draggable={false} /> : <Cat size={size === 'large' ? 42 : 23} />}
    </span>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content ${className}`}
          onOpenAutoFocus={event => {
            event.preventDefault();
          }}
        >
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton icon={X} label="关闭窗口" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function InlineError({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="inline-error">
      {message}
    </p>
  ) : null;
}
